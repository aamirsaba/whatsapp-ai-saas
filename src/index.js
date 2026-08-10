require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { startWhatsAppSession } = require('./whatsapp');
const { registerUser, loginUser } = require('./auth');
const { authenticateToken } = require('./middleware'); // 🚀 NEW: Auth Middleware
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const prisma = new PrismaClient();
app.use(express.json());

// 🧠 CACHE TO REMEMBER THE LATEST QR CODE FOR EACH NUMBER
const qrCache = {};
const activeSockets = new Map(); // Shared with whatsapp.js

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
  try {
    const { systemPrompt, businessContext, llmApiKey, llmModel } = req.body;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { 
        systemPrompt: systemPrompt || tenant.systemPrompt,
        businessContext: businessContext || tenant.businessContext,
        llmApiKey: llmApiKey || tenant.llmApiKey,
        llmModel: llmModel || tenant.llmModel
      }
    });

    res.json({ success: true, message: '✨ AI Persona updated successfully!' });
  } catch (error) {
    console.error('Dashboard update error:', error);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

app.post('/api/dashboard/disconnect', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

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

app.get('/connect/:phoneNumber', (req, res) => {
  const { phoneNumber } = req.params;
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp AI SaaS Backend is running!`);
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});