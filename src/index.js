require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { startWhatsAppSession, activeSockets } = require('./whatsapp');
const { registerUser, loginUser } = require('./auth');
const { authenticateToken } = require('./middleware'); // 🚀 NEW: Auth Middleware
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const prisma = new PrismaClient();
app.use(express.json());

// 🧠 CACHE TO REMEMBER THE LATEST QR CODE FOR EACH NUMBER
const qrCache = {};

// ==========================================
// 🚀 AUTH ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, businessName, whatsappNumber, businessContext } = req.body;
    
    // 🚨 Password is now OPTIONAL. Backend will auto-generate if missing.
    if (!email || !businessName || !whatsappNumber || !businessContext) {
      return res.status(400).json({ error: 'Email, business name, WhatsApp number, and Business Context are all required.' });
    }
    
    const cleanNumber = whatsappNumber.replace(/\D/g, '');
    const result = await registerUser(email, password, businessName, cleanNumber, businessContext);
    
    startWhatsAppSession(result.tenant.id, cleanNumber, handleQr, handleSuccess);

    res.status(201).json({ success: true, message: 'Account created! Check your email for your auto-generated password.', ...result });
  } catch (error) {
    console.error('❌ Registration Error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    
    const result = await loginUser(email, password);
    res.json({ success: true, message: 'Logged in successfully!', ...result });
  } catch (error) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// ==========================================
// 🚀 DASHBOARD ROUTES (Protected)
// ==========================================
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'No business found for this user.' });

    const messages = await prisma.message.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    res.json({ success: true, tenant, messages });
  } catch (error) {
    console.error('Dashboard load error:', error);
    res.status(500).json({ error: 'Failed to load dashboard data.' });
  }
});

app.put('/api/dashboard/settings', authenticateToken, async (req, res) => {
  console.log("🔍 SETTINGS ROUTE HIT! Body:", req.body); // 🚨 ADD THIS LINE
  
  try {
    const { systemPrompt, businessContext, contactInfo, llmApiKey, llmModel, llmProvider, llmBaseUrl, isHumanMode, leadWebhookUrl } = req.body;
    // ... rest of the code
    
    if (!llmApiKey) {
      return res.status(400).json({ error: 'LLM API Key is strictly required.' });
    }

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { 
        systemPrompt: systemPrompt !== undefined ? systemPrompt : tenant.systemPrompt,
        businessContext: businessContext !== undefined ? businessContext : tenant.businessContext,
        contactInfo: contactInfo !== undefined ? contactInfo : tenant.contactInfo,
        llmApiKey: llmApiKey,
        llmModel: llmModel || tenant.llmModel,
        llmProvider: llmProvider || tenant.llmProvider || 'OPENAI',
        llmBaseUrl: llmBaseUrl,
        isHumanMode: isHumanMode === true || isHumanMode === 'true', // 🚨 CRITICAL: This saves the toggle state
	leadWebhookUrl: leadWebhookUrl || null //  Save the webhook URL
      }
    });

    res.json({ success: true, message: '✨ AI Settings updated successfully!' });
  } catch (error) {
    console.error('❌ Dashboard update error DETAILS:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    res.status(500).json({ error: 'Failed to update settings. Check server logs.', details: error.message });
  }
});

app.post('/api/dashboard/disconnect', authenticateToken, async (req, res) => {
  try {
    console.log("🔍 Disconnect attempt for userId:", req.user.userId);
    
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    
    if (!tenant) {
      console.log("❌ No tenant found for userId:", req.user.userId);
      
      // Let's see what's actually in the database to spot the mismatch
      const allTenants = await prisma.tenant.findMany({ select: { id: true, businessName: true, userId: true } });
      console.log("📊 Total tenants in DB:", allTenants.length, allTenants);
      
      return res.status(404).json({ error: 'Business not found. Please check if you are logged into the correct account, or try logging out and back in.' });
    }

    const sock = activeSockets.get(tenant.whatsappNumber);
    if (sock) {
      await sock.logout();
      activeSockets.delete(tenant.whatsappNumber);
    }

    const authDir = path.join(process.cwd(), `auth_info_${tenant.whatsappNumber}`);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

    await prisma.tenant.update({ where: { id: tenant.id }, data: { isActive: false } });
    res.json({ success: true, message: 'WhatsApp disconnected successfully.' });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

app.delete('/api/dashboard/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenant = await prisma.tenant.findFirst({ where: { userId } });

    if (tenant) {
      const sock = activeSockets.get(tenant.whatsappNumber);
      if (sock) { 
        await sock.logout(); 
        activeSockets.delete(tenant.whatsappNumber); 
      }
      await prisma.message.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
    
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// ==========================================
// 🌐 WEBSOCKET & QR CODE ROUTES
// ==========================================
wss.on('connection', (ws) => {
  for (const [num, qr] of Object.entries(qrCache)) {
    ws.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num }));
  }
});

// 🌐 CUSTOMER-FACING QR CODE PAGE
app.get('/connect/:phoneNumber', async (req, res) => {
  const { phoneNumber } = req.params;
  
  // 🚨 NEW: Auto-start session if not already running
  if (!activeSockets.has(phoneNumber)) {
    try {
      const tenant = await prisma.tenant.findUnique({ where: { whatsappNumber: phoneNumber } });
      if (tenant) {
        console.log(`🔄 Auto-starting session for QR page visitor: ${phoneNumber}`);
        startWhatsAppSession(tenant.id, phoneNumber, handleQr, handleSuccess);
      }
    } catch (err) {
      console.error('Failed to auto-start session:', err);
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Connect WhatsApp</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
      <div class="container text-center p-10 bg-white rounded-xl shadow-lg max-w-md w-full mx-4">
        <div class="bg-red-50 border-l-4 border-red-500 p-4 mb-6 rounded-md text-left">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
              </svg>
            </div>
            <div class="ml-3">
              <p class="text-sm text-red-700 font-bold">⚠️ CRITICAL: You MUST scan this with <span class="text-red-900">${phoneNumber}</span></p>
              <p class="text-xs text-red-600 mt-1">Scanning with a different number will break the bot and trigger a security lock.</p>
            </div>
          </div>
        </div>
        
        <h1 class="text-2xl font-bold mb-2">Link your WhatsApp</h1>
        <div class="text-green-600 text-xl font-bold mb-4">${phoneNumber}</div>
        <div id="qrcode" class="mx-auto p-4 bg-white border border-gray-200 rounded-lg inline-block"><p class="text-gray-400 py-8">Generating QR Code...</p></div>
        
        <div class="text-left text-sm text-gray-600 mt-6 space-y-2">
          <p><strong>How to link:</strong></p>
          <ol class="list-decimal list-inside space-y-1">
            <li>Open WhatsApp on your phone</li>
            <li>Tap <strong>⋮</strong> or <strong>Settings</strong> > <strong>Linked Devices</strong></li>
            <li>Tap <strong>Link a Device</strong></li>
            <li>Point your phone at this screen to scan</li>
          </ol>
        </div>
        <div id="status" class="mt-6 p-3 rounded-lg font-bold text-sm bg-gray-100 text-gray-600">⏳ Waiting for QR code...</div>
      </div>

      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <script>
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
        let qrCodeObj = null;

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'qr' && data.phoneNumber === '${phoneNumber}') {
            document.getElementById('qrcode').innerHTML = '';
            qrCodeObj = new QRCode(document.getElementById('qrcode'), {
              text: data.qr, width: 220, height: 220, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.L
            });
            document.getElementById('status').textContent = '📱 Scan the QR code now';
            document.getElementById('status').className = 'mt-6 p-3 rounded-lg font-bold text-sm bg-blue-50 text-blue-700';
          }
          if (data.type === 'success' && data.phoneNumber === '${phoneNumber}') {
            document.getElementById('status').className = 'mt-6 p-3 rounded-lg font-bold text-sm bg-green-100 text-green-700';
            document.getElementById('status').textContent = '✅ Connected successfully! Your AI is now active.';
            document.getElementById('qrcode').innerHTML = '<div class="text-6xl text-green-500">✓</div>';
          }
        };
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// 🌐 STATIC PAGES & LEGACY ROUTES
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

const handleQr = (num, qr) => {
  qrCache[num] = qr;
  wss.clients.forEach(client => { 
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num })); 
  });
};

const handleSuccess = (num) => {
  delete qrCache[num];
  wss.clients.forEach(client => { 
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'success', phoneNumber: num })); 
  });
};

app.post('/api/connect', async (req, res) => {
  try {
    const { businessName, whatsappNumber } = req.body;
    const formattedNumber = whatsappNumber.replace(/\D/g, ''); 
    const tenant = await prisma.tenant.upsert({
      where: { whatsappNumber: formattedNumber },
      update: { businessName },
      create: { 
        businessName, 
        whatsappNumber: formattedNumber,
        systemPrompt: "أنت مساعد ذكي ولطيف. رد باختصار وبشكل احترافي."
      }
    });
    startWhatsAppSession(tenant.id, formattedNumber, handleQr, handleSuccess);
    res.json({ success: true, message: "Session started. Visit /connect/" + formattedNumber + " to scan.", tenantId: tenant.id });
  } catch (error) {
    console.error("❌ Connection Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const { scrapeWebsiteContext } = require('./scraper'); // Add this at the top with other requires

// ... (keep all your existing routes) ...

// 🚀 NEW: SCRAPE WEBSITE FOR AI CONTEXT (Protected)
app.post('/api/dashboard/scrape-website', authenticateToken, async (req, res) => {
  try {
    const { websiteUrl } = req.body;
    if (!websiteUrl) return res.status(400).json({ error: 'Website URL is required.' });

    const scrapedText = await scrapeWebsiteContext(websiteUrl);
    
    if (!scrapedText) {
      return res.status(400).json({ error: 'Could not extract text from this website. Please enter the context manually.' });
    }

    // Format it into a perfect AI prompt
    const generatedContext = `This business is based on their website (${websiteUrl}). Here is their core information: ${scrapedText}. Use this information to answer customer questions accurately and professionally.`;

    res.json({ success: true, generatedContext });
  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: 'Failed to scrape website.' });
  }
});

// Helper to pick the best model from a list
function pickBestModel(models, provider) {
  // Filter for text/chat models (ignore image/audio models)
  const chatModels = models.filter(m => 
    m.id.toLowerCase().includes('chat') || 
    m.id.toLowerCase().includes('gpt') || 
    m.id.toLowerCase().includes('qwen') ||
    m.id.toLowerCase().includes('turbo') ||
    m.id.toLowerCase().includes('mini')
  );
  
  const candidates = chatModels.length > 0 ? chatModels : models;
  if (candidates.length === 0) return null;

  // Priority logic based on provider
  if (provider === 'OPENAI') {
    // Prefer gpt-4o-mini (smart & cheap), then gpt-4o, then gpt-3.5
    const priority = ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
    for (let p of priority) {
      const found = candidates.find(m => m.id === p);
      if (found) return found.id;
    }
  }
  
  if (provider === 'QWEN') {
    // Prefer qwen-plus (best balance), qwen-max, qwen-turbo
    const priority = ['qwen-plus', 'qwen-max', 'qwen-turbo'];
    for (let p of priority) {
      const found = candidates.find(m => m.id === p);
      if (found) return found.id;
    }
  }

  // Fallback to the first available model
  return candidates[0].id;
}

// 🚀 SMART VALIDATE & AUTO-DETECT LLM API KEY
app.post('/api/dashboard/validate-llm', authenticateToken, async (req, res) => {
  try {
    const { llmApiKey } = req.body;
    if (!llmApiKey) return res.status(400).json({ error: 'API Key is required' });

    let detectedModel = null;
    let provider = 'UNKNOWN';
    let baseUrl = null;

    // 1. Try OpenAI
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${llmApiKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        detectedModel = pickBestModel(data.data, 'OPENAI');
        if (detectedModel) {
          provider = 'OPENAI';
          baseUrl = 'https://api.openai.com/v1';
        }
      }
    } catch (e) { /* ignore */ }

    // 2. If not OpenAI, try Qwen (DashScope)
    if (!detectedModel) {
      try {
        const response = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', {
          headers: { 'Authorization': `Bearer ${llmApiKey}` }
        });
        if (response.ok) {
          const data = await response.json();
          detectedModel = pickBestModel(data.data, 'QWEN');
          if (detectedModel) {
            provider = 'QWEN';
            baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (detectedModel) {
      res.json({ 
        success: true, 
        detectedModel, 
        provider, 
        baseUrl,
        message: `✅ Valid ${provider} Key! Auto-selected best model: ${detectedModel}` 
      });
    } else {
      res.status(400).json({ error: ' Invalid API Key or no chat models found.' });
    }
  } catch (error) {
    console.error('Validate LLM error:', error);
    res.status(500).json({ error: 'Failed to validate API key.' });
  }
});

// 🚀 NEW: Auto-start all active WhatsApp sessions when the server boots up
async function startAllActiveSessions() {
  try {
    const activeTenants = await prisma.tenant.findMany({ where: { isActive: true } });
    console.log(`🔄 Found ${activeTenants.length} active tenant(s). Starting sessions...`);
    
    for (const tenant of activeTenants) {
      console.log(`🔄 Auto-starting session for: ${tenant.whatsappNumber}`);
      startWhatsAppSession(tenant.id, tenant.whatsappNumber, handleQr, handleSuccess);
    }
  } catch (error) {
    console.error('❌ Failed to start active sessions:', error);
  }
}

// 🚀 AUTOPILOT DAILY BRIEF ROUTE (Protected)
app.post('/api/dashboard/daily-summary', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    // 1. Get today's messages
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todaysMessages = await prisma.message.findMany({
      where: { tenantId: tenant.id, createdAt: { gte: startOfDay } },
      orderBy: { createdAt: 'asc' }
    });

    if (todaysMessages.length === 0) {
      return res.json({ success: true, summary: "📊 No messages received today! Time to run some marketing campaigns." });
    }

    // 2. Format messages for AI
    const chatLog = todaysMessages.map(m => `[${m.direction === 'inbound' ? 'Customer' : 'AI/Bot'}] ${m.fromNumber}: ${m.content}`).join('\n');

    // 3. Generate Summary using AI
    const systemPrompt = "You are an executive assistant to the business owner. Summarize the following daily WhatsApp chat logs into a brief, professional daily brief. Highlight: 1. Total number of interactions. 2. Key lead inquiries or services requested. 3. Any unresolved issues. Keep it concise, use bullet points, and maintain a professional tone.";
    const { getAIResponse } = require('./ai');
    const summary = await getAIResponse(chatLog, systemPrompt, tenant);

    // 4. Send to WhatsApp "Message Yourself"
    const sock = activeSockets.get(tenant.whatsappNumber);
    if (sock) {
      try {
        // Use the bot's own number as the JID for "Message Yourself"
        const selfJid = `${tenant.whatsappNumber}@s.whatsapp.net`;
        console.log(` Sending summary to self JID: ${selfJid}`);
        
        await sock.sendMessage(selfJid, { 
          text: `📊 *Daily AI Summary for ${tenant.businessName}*\n\n${summary}` 
        });
        console.log('✅ Summary sent to WhatsApp "Message Yourself"');
      } catch (waError) {
        console.error("⚠️ Could not send to WhatsApp 'Message Yourself':", waError.message);
      }
    } else {
      console.log("⚠️ No active socket found for this tenant");
    }

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Daily summary error:', error);
    res.status(500).json({ error: 'Failed to generate daily summary.' });
  }
});


// 🚀 AUTO-SAVE HUMAN TAKEOVER TOGGLE
app.patch('/api/dashboard/toggle-human-mode', authenticateToken, async (req, res) => {
  try {
    const { isHumanMode } = req.body;
    console.log(`🔄 Toggling Human Mode to: ${isHumanMode} for user: ${req.user.userId}`);

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { isHumanMode: Boolean(isHumanMode) }
    });

    res.json({ success: true, isHumanMode: Boolean(isHumanMode) });
  } catch (error) {
    console.error('❌ Toggle human mode error:', error);
    res.status(500).json({ error: 'Failed to toggle mode.' });
  }
});

// 🚀 CRM: Get All Leads
app.get('/api/dashboard/leads', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });
    
    const leads = await prisma.lead.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, leads });
  } catch (error) {
    console.error('❌ Fetch leads error:', error);
    res.status(500).json({ error: 'Failed to fetch leads.' });
  }
});

// 🚀 CRM: Update Lead Status or Notes
app.patch('/api/dashboard/leads/:id', authenticateToken, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    
    // Verify ownership
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, tenantId: tenant.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    const updatedLead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { 
        status: status || lead.status,
        notes: notes !== undefined ? notes : lead.notes
      }
    });
    res.json({ success: true, lead: updatedLead });
  } catch (error) {
    console.error('❌ Update lead error:', error);
    res.status(500).json({ error: 'Failed to update lead.' });
  }
});

// 🚀 TEAM: Get All Clients (Tenants) for the User
app.get('/api/dashboard/clients', authenticateToken, async (req, res) => {
  try {
    const clients = await prisma.tenant.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, clients });
  } catch (error) {
    console.error('❌ Fetch clients error:', error);
    res.status(500).json({ error: 'Failed to fetch clients.' });
  }
});

// 🚀 TEAM: Invite Agent to Tenant
app.post('/api/dashboard/team/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const userToAdd = await prisma.user.findUnique({ where: { email } });
    if (!userToAdd) return res.status(404).json({ error: 'User with this email does not exist. They must register first.' });

    await prisma.teamMember.create({
      data: { tenantId: tenant.id, userId: userToAdd.id, role: 'AGENT' }
    });

    res.json({ success: true, message: 'Agent added successfully!' });
  } catch (error) {
    console.error('❌ Invite error:', error);
    res.status(500).json({ error: 'Failed to invite agent.' });
  }
});

// 🚀 TEAM: Get Team Members
app.get('/api/dashboard/team', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const members = await prisma.teamMember.findMany({
      where: { tenantId: tenant.id },
      include: { user: { select: { email: true } } }
    });
    res.json({ success: true, members });
  } catch (error) {
    console.error('❌ Fetch team error:', error);
    res.status(500).json({ error: 'Failed to fetch team.' });
  }
});

//  LIVE INBOX: Send Manual Reply via WhatsApp
app.post('/api/dashboard/send-message', authenticateToken, async (req, res) => {
  try {
    const { toNumber, content, tenantId } = req.body;
    
    const tenant = await prisma.tenant.findFirst({ 
      where: { id: tenantId || req.query.tenantId, userId: req.user.userId } 
    });
    if (!tenant) return res.status(403).json({ error: 'Access denied.' });

    const sock = activeSockets.get(tenant.whatsappNumber);
    if (!sock) return res.status(400).json({ error: 'WhatsApp is not connected.' });

    const jid = `${toNumber}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: content });

    await prisma.message.create({
      data: {
        tenantId: tenant.id,
        fromNumber: tenant.whatsappNumber,
        toNumber: toNumber,
        direction: 'outbound',
        content: content,
        isAiReply: false
      }
    });

    res.json({ success: true, message: 'Message sent!' });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp AI SaaS Backend is running!`);
  console.log(`🌐 Server running on http://localhost:${PORT}`);
  
  // 🚀 CALL THE AUTO-START FUNCTION HERE
  startAllActiveSessions();
  // 🚀 AUTOMATED DAILY BRIEF CRON JOB
  // Runs every minute to check if any tenant needs a summary right now
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Format current time as "HH:MM" (e.g., "21:05")
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      
      // Find tenants who want a summary at this exact minute
      const tenantsToNotify = await prisma.tenant.findMany({
        where: {
          isSummaryEnabled: true,
          summaryTime: currentTime,
          isActive: true // Only send if WhatsApp is connected
        }
      });

      if (tenantsToNotify.length > 0) {
        console.log(`⏰ Cron Job: Sending daily briefs to ${tenantsToNotify.length} tenant(s) at ${currentTime}`);
        
        for (const tenant of tenantsToNotify) {
          try {
            // 1. Get today's messages
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            
            const todaysMessages = await prisma.message.findMany({
              where: { tenantId: tenant.id, createdAt: { gte: startOfDay } },
              orderBy: { createdAt: 'asc' }
            });

            if (todaysMessages.length === 0) continue; // Skip if no messages

            // 2. Format and generate AI summary
            const chatLog = todaysMessages.map(m => `[${m.direction === 'inbound' ? 'Customer' : 'AI'}] ${m.fromNumber}: ${m.content}`).join('\n');
            const systemPrompt = "Summarize this daily WhatsApp chat log into a brief, professional daily brief. Highlight: 1. Total interactions. 2. Key lead inquiries. 3. Unresolved issues. Use bullet points.";
            const { getAIResponse } = require('./ai');
            const summary = await getAIResponse(chatLog, systemPrompt, tenant);

            // 3. Send to WhatsApp "Message Yourself"
            const sock = activeSockets.get(tenant.whatsappNumber);
            if (sock) {
              const selfJid = `${tenant.whatsappNumber}@s.whatsapp.net`;
              await sock.sendMessage(selfJid, { text: `📊 *Daily AI Summary for ${tenant.businessName}*\n\n${summary}` });
              console.log(`✅ Sent automated brief to ${tenant.businessName}`);
            }
          } catch (err) {
            console.error(`❌ Failed to send brief to ${tenant.businessName}:`, err.message);
          }
        }
      }
    } catch (error) {
      console.error('❌ Cron job error:', error);
    }
  });
 
});

