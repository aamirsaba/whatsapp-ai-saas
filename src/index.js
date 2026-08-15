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
    const { email, password, businessName, whatsappNumber, businessContext, inviteToken } = req.body;
    
    // 🚨 NEW: Check if this is an invitation registration
    if (inviteToken) {
      // Verify the invitation token matches the email
      // For now, we'll just trust the token and auto-add them
      console.log(`🎉 Processing invitation registration for ${email}`);
    }
    
    // 🚨 Password is now OPTIONAL. Backend will auto-generate if missing.
    if (!email || !businessName || !whatsappNumber || !businessContext) {
      return res.status(400).json({ error: 'Email, business name, WhatsApp number, and Business Context are all required.' });
    }
    
    const cleanNumber = whatsappNumber.replace(/\D/g, '');
    const result = await registerUser(email, password, businessName, cleanNumber, businessContext);
    
    // 🚨 NEW: If they registered via invitation, auto-add them as team member
    if (inviteToken && result.tenant) {
      try {
        // Find the tenant who sent the invitation
        // This requires knowing which tenant invited them
        // For MVP, we'll skip this and just log it
        console.log(`✅ User ${email} registered via invitation. Auto-adding as team member (TODO: implement auto-add logic)`);
      } catch (teamError) {
        console.error('Failed to auto-add as team member:', teamError);
      }
    }
    
    startWhatsAppSession(result.tenant.id, cleanNumber, handleQr, handleSuccess);

    res.status(201).json({ success: true, message: 'Account created! Check your email for your auto-generated password.', ...result });
  } catch (error) {
    console.error('❌ Registration Error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// 🚀 5-MINUTE MVP WIZARD REGISTRATION (AUTO-GENERATE PASSWORD)
app.post('/api/register-wizard', async (req, res) => {
  try {
    const { email, businessName, industry, websiteUrl, whatsappNumber, botType } = req.body;

    // 1. Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: 'Email already in use.' });

    // 2. 🚨 AUTO-GENERATE SECURE 12-CHARACTER PASSWORD
    const crypto = require('crypto');
    const autoPassword = crypto.randomBytes(6).toString('hex');
    const hashedPassword = await require('bcryptjs').hash(autoPassword, 10);
    
    const newUser = await prisma.user.create({
      data: { email, password: hashedPassword, role: 'TENANT' }
    });

    // 3. Auto-generate Context based on Industry
    let autoContext = `This business operates in the ${industry} industry.`;
    if (websiteUrl) autoContext += ` Their website is ${websiteUrl}. Use this context to answer questions accurately.`;
    
    // 4. 🚨 SMART INDUSTRY-TO-PROMPT MAPPING
    let autoPrompt = "You are a helpful, professional AI assistant for this business. Be concise, polite, and accurate.";
    
    // 🚨 DECLARE 'ind' ONLY ONCE HERE:
    const ind = industry.toLowerCase();
    
    // 🎭 PERSONAL BOT CATEGORIES
    if (ind.includes('emotional')) {
      autoPrompt = "You are a compassionate, empathetic emotional support companion. Listen actively, validate feelings, offer coping strategies. Never diagnose. Encourage professional help for serious issues.";
    }
    else if (ind.includes('islamic') || ind.includes('scholar')) {
      autoPrompt = "You are a knowledgeable Islamic scholar assistant. Answer questions based on Quran and authentic Sunnah. Provide Arabic references. Be respectful and compassionate.";
    }
    else if (ind.includes('depression') || ind.includes('relief')) {
      autoPrompt = "You are a supportive mental health companion. Use gentle encouragement, track mood patterns, and suggest healthy coping mechanisms. Always include a gentle reminder to seek professional help if in crisis.";
    }
    else if (ind.includes('storytelling')) {
      autoPrompt = "You are a master storyteller. Create engaging narratives with vivid descriptions, strong characters, and compelling plots. Adapt to the user's preferred genre.";
    }
    else if (ind.includes('content creation')) {
      autoPrompt = "You are a viral content strategist. Help create YouTube scripts, social media posts, and blog ideas. Focus on hooks, retention, and audience engagement.";
    }
    else if (ind.includes('cooking')) {
      autoPrompt = "You are a professional chef assistant. Provide recipes, cooking techniques, meal planning, and dietary substitutions. Be encouraging, practical, and safety-conscious.";
    }
    else if (ind.includes('faith') || ind.includes('spirituality')) {
      autoPrompt = "You are a supportive faith and spirituality guide. Offer encouragement, positive affirmations, and spiritual wisdom. Be respectful and uplifting.";
    }
    else if (ind.includes('personal development')) {
      autoPrompt = "You are a personal development coach. Help set goals, track progress, build habits, and stay motivated. Be encouraging, practical, and action-oriented.";
    }
    // 🏠 BUSINESS BOT CATEGORIES
    else if (ind.includes('real estate') || ind.includes('property')) {
      autoPrompt = "You are a top-tier Real Estate AI Sales Agent. Your goal is to qualify buyers/renters, answer property questions, showcase listings, and proactively book property viewings. Always ask about their budget and preferred location.";
    }
    else if (ind.includes('automotive') || ind.includes('dealership')) {
      autoPrompt = "You are a professional Automotive Dealership AI Assistant. Help customers with vehicle inquiries, test drive bookings, financing questions, and service appointments. Be knowledgeable and persuasive.";
    }
    else if (ind.includes('e-commerce') || ind.includes('online store') || ind.includes('retail')) {
      autoPrompt = "You are an E-commerce AI Sales Assistant. Help customers with product questions, order status, shipping info, returns, and drive conversions. Be friendly and solution-oriented.";
    }
    else if (ind.includes('restaurant') || ind.includes('cafe') || ind.includes('food')) {
      autoPrompt = "You are a Restaurant AI Host. Help customers with menu questions, dietary restrictions, table reservations, delivery options, and operating hours. Be warm and welcoming.";
    }
    else if (ind.includes('hotel') || ind.includes('resort') || ind.includes('hospitality')) {
      autoPrompt = "You are a Hotel & Hospitality AI Concierge. Assist with room bookings, amenities, check-in/out times, local attractions, and special requests. Be elegant and service-oriented.";
    }
    else if (ind.includes('travel') || ind.includes('tourism') || ind.includes('ticketing')) {
      autoPrompt = "You are a Travel & Tourism AI Agent. Help with bookings, itineraries, visa info, package details, and travel recommendations. Be enthusiastic and detail-oriented.";
    }
    else if (ind.includes('event')) {
      autoPrompt = "You are an Event Planning AI Coordinator. Help clients with venue options, packages, catering, guest management, and booking consultations. Be organized and creative.";
    }
    else if (ind.includes('medical') || ind.includes('clinic') || ind.includes('healthcare') || ind.includes('hospital')) {
      autoPrompt = "You are a professional Medical Clinic AI Receptionist. Answer patient questions, provide clinic hours, help with appointment booking, and handle general inquiries. ⚠️ CRITICAL: Never provide medical diagnoses. Always advise consulting a doctor for health concerns.";
    }
    else if (ind.includes('beauty') || ind.includes('salon') || ind.includes('spa')) {
      autoPrompt = "You are a Beauty Salon & Spa AI Assistant. Help clients with service menus, pricing, stylist availability, and appointment bookings. Be friendly and make them feel pampered.";
    }
    else if (ind.includes('fitness') || ind.includes('gym') || ind.includes('training')) {
      autoPrompt = "You are a Fitness & Gym AI Assistant. Help with membership plans, class schedules, trainer bookings, and facility info. Be motivating and energetic.";
    }
    else if (ind.includes('mental health') || ind.includes('counseling')) {
      autoPrompt = "You are a Mental Health & Counseling AI Assistant. Help with appointment booking, service info, and general inquiries. Be empathetic and supportive. ⚠️ CRITICAL: Never provide medical advice. In crisis situations, always direct to emergency services.";
    }
    else if (ind.includes('vet') || ind.includes('pet')) {
      autoPrompt = "You are a Veterinary Clinic AI Assistant. Help pet owners with appointment booking, service info, and general pet care questions. Be caring and knowledgeable. ⚠️ Never provide emergency medical advice - direct to the vet immediately for urgent issues.";
    }
    else if (ind.includes('field service') || ind.includes('home maintenance') || ind.includes('plumbing') || ind.includes('ac') || ind.includes('electrical')) {
      autoPrompt = "You are a Field Service AI Dispatcher. Confirm service areas, answer pricing questions, book technician visits, and handle emergency requests. Be efficient and reassuring.";
    }
    else if (ind.includes('cleaning')) {
      autoPrompt = "You are a Cleaning Services AI Coordinator. Help clients with service types (residential/commercial), pricing, scheduling, and special requests. Be thorough and trustworthy.";
    }
    else if (ind.includes('construction') || ind.includes('architecture') || ind.includes('contracting')) {
      autoPrompt = "You are a Construction & Contracting AI Assistant. Help with project inquiries, quotes, service areas, and consultation bookings. Be professional and detail-oriented.";
    }
    else if (ind.includes('logistics') || ind.includes('delivery') || ind.includes('courier')) {
      autoPrompt = "You are a Logistics & Delivery AI Assistant. Help with shipping quotes, tracking, service areas, and booking pickups. Be fast and accurate.";
    }
    else if (ind.includes('legal') || ind.includes('law')) {
      autoPrompt = "You are a Law Firm AI Assistant. Help with practice areas, attorney info, consultation bookings, and general inquiries. Be professional and discreet. ⚠️ Never provide specific legal advice - always direct to an attorney.";
    }
    else if (ind.includes('financial') || ind.includes('accounting') || ind.includes('tax') || ind.includes('wealth')) {
      autoPrompt = "You are a Financial Services AI Assistant. Help with service info, appointment bookings, and general inquiries. Be professional and trustworthy. ⚠️ Never provide specific financial or investment advice.";
    }
    else if (ind.includes('marketing') || ind.includes('advertising') || ind.includes('agency')) {
      autoPrompt = "You are a Marketing Agency AI Assistant. Help potential clients with service offerings, case studies, pricing, and consultation bookings. Be creative and results-focused.";
    }
    else if (ind.includes('it') || ind.includes('software') || ind.includes('saas')) {
      autoPrompt = "You are an IT & Software Solutions AI Assistant. Help with product demos, pricing, technical questions, and sales inquiries. Be knowledgeable and solution-oriented.";
    }
    else if (ind.includes('hr') || ind.includes('recruitment') || ind.includes('staffing')) {
      autoPrompt = "You are an HR & Recruitment AI Assistant. Help with service info, candidate inquiries, client bookings, and general questions. Be professional and people-focused.";
    }
    else if (ind.includes('school') || ind.includes('university') || ind.includes('academy')) {
      autoPrompt = "You are an Educational Institution AI Assistant. Help with admissions, programs, fees, campus info, and enrollment. Be informative and welcoming.";
    }
    else if (ind.includes('online course') || ind.includes('tutoring')) {
      autoPrompt = "You are an Online Education AI Assistant. Help with course info, enrollment, pricing, and instructor details. Be encouraging and helpful.";
    }
    else if (ind.includes('coaching') || ind.includes('consulting')) {
      autoPrompt = "You are a Coaching & Consulting AI Assistant. Help potential clients understand your services, book discovery calls, and answer FAQs. Be inspiring and professional.";
    }
    else if (ind.includes('media') || ind.includes('publishing') || ind.includes('content')) {
      autoPrompt = "You are a Media & Content Creation AI Assistant. Help with service inquiries, portfolio info, collaboration requests, and bookings. Be creative and engaging.";
    }
    else if (ind.includes('non-profit') || ind.includes('community')) {
      autoPrompt = "You are a Non-Profit Organization AI Assistant. Help with mission info, volunteering, donations, and events. Be warm and mission-driven.";
    }
    else if (ind.includes('government') || ind.includes('public service')) {
      autoPrompt = "You are a Government & Public Service AI Assistant. Help citizens with service info, office hours, required documents, and procedures. Be clear and respectful.";
    }

    // 5. Create Tenant
    const newTenant = await prisma.tenant.create({
      data: {
        businessName,
        whatsappNumber,
        websiteUrl,
        userId: newUser.id,
        systemPrompt: autoPrompt,
        businessContext: autoContext,
        isActive: false,
        isHumanMode: false
      }
    });

    // 6. Generate JWT
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ userId: newUser.id, role: newUser.role }, process.env.JWT_SECRET || 'your-super-secret-jwt-key', { expiresIn: '7d' });

    // 7. 🚨 SEND WELCOME EMAIL & ADMIN NOTIFICATION (SKIPPED LOCALLY TO PREVENT TIMEOUT)
  
    try {
      const { sendWelcomeEmail, sendAdminNotificationEmail } = require('./email');
      
      await sendWelcomeEmail(email, businessName, autoPassword);
      console.log(`✅ Welcome email sent to ${email}`);
      
      await sendAdminNotificationEmail(email, businessName, whatsappNumber, botType);
      console.log(`✅ Admin notification sent for ${businessName}`);
      
    } catch (emailError) {
      console.error('❌ Failed to send emails:', emailError);
    }
      console.log(`✅ Account created successfully for ${email} (Email sending skipped locally)`);

    res.json({ 
      success: true, 
      token, 
      user: { id: newUser.id, email: newUser.email, role: newUser.role },
      redirectUrl: `/connect/${whatsappNumber}`
    });
  } catch (error) {
    console.error('❌ Wizard registration error:', error);
    res.status(500).json({ error: 'Failed to create account: ' + error.message });
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
        // 🚨 NEW: Completely ignore systemPrompt from user input. Keep the original auto-generated one.
        systemPrompt: tenant.systemPrompt, 
        businessContext: businessContext !== undefined ? businessContext : tenant.businessContext,
        contactInfo: contactInfo !== undefined ? contactInfo : tenant.contactInfo,
        llmApiKey: llmApiKey,
        llmModel: llmModel || tenant.llmModel,
        llmProvider: llmProvider || tenant.llmProvider || 'OPENAI',
        llmBaseUrl: llmBaseUrl,
        isHumanMode: isHumanMode === true || isHumanMode === 'true',
        leadWebhookUrl: leadWebhookUrl || null
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
          // In the WebSocket onmessage handler, add this:
if (data.type === 'success' && data.phoneNumber === '${phoneNumber}') {
  document.getElementById('status').className = 'mt-6 p-3 rounded-lg font-bold text-sm bg-green-100 text-green-700';
  document.getElementById('status').textContent = '✅ Connected successfully! Redirecting to dashboard...';
  document.getElementById('qrcode').innerHTML = '<div class="text-6xl text-green-500">✓</div>';
  
  // 🚨 AUTO-REDIRECT TO DASHBOARD AFTER 2 SECONDS
  setTimeout(() => {
    window.location.href = '/dashboard';
  }, 2000);
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
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')); // The new Landing Page
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html')); // The new 3-Step Wizard
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'accept-invitation.html'));
});


app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html'));
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ success: true, message: 'If email exists, reset link sent.' }); // Security: don't reveal if email exists

    // Generate reset token
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken, resetTokenExpiry }
    });

    // Send email with reset link
    const { sendPasswordResetEmail } = require('./email');
    const resetUrl = `https://bot.aamirsaba.com/reset-password?token=${resetToken}`;
    await sendPasswordResetEmail(email, resetUrl);

    res.json({ success: true, message: 'If email exists, reset link sent.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process request.' });
  }
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

// 🚀 TEAM: Invite Agent (Creates DB Record + Sends Email)
app.post('/api/dashboard/team/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Check if already a team member
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const existingMember = await prisma.teamMember.findFirst({
        where: { tenantId: tenant.id, userId: existingUser.id }
      });
      if (existingMember) {
        return res.status(400).json({ error: 'This user is already a team member.' });
      }
      // Auto-add existing user
      await prisma.teamMember.create({
        data: { tenantId: tenant.id, userId: existingUser.id, role: 'AGENT' }
      });
      return res.json({ success: true, message: `${email} added as agent successfully!` });
    }

    // Check for pending invitation
    const pendingInvite = await prisma.teamInvitation.findFirst({
      where: { email, tenantId: tenant.id, accepted: false, expiresAt: { gt: new Date() } }
    });
    if (pendingInvite) {
      return res.json({ success: true, message: `Invitation already sent to ${email}. Link expires in 7 days.` });
    }

    // Create invitation record
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.teamInvitation.create({
      data: { email, tenantId: tenant.id, token, expiresAt }
    });

    // Send email
    const inviteLink = `https://bot.aamirsaba.com/accept-invitation?email=${encodeURIComponent(email)}&token=${token}`;
    const { sendAgentInvitationEmail } = require('./email');
    await sendAgentInvitationEmail(email, tenant.businessName, inviteLink);

    res.json({ success: true, message: `Invitation email sent to ${email}.` });
  } catch (error) {
    console.error(' Invite error:', error);
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

// 📊 ANALYTICS: Get Dashboard Stats for Charts
app.get('/api/dashboard/analytics', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const messages = await prisma.message.findMany({ where: { tenantId: tenant.id, createdAt: { gte: sevenDaysAgo } } });
    const leads = await prisma.lead.findMany({ where: { tenantId: tenant.id, createdAt: { gte: sevenDaysAgo } } });

    const labels = [], messageCounts = [], leadCounts = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      labels.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
      const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(d); dayEnd.setHours(23,59,59,999);
      messageCounts.push(messages.filter(m => m.createdAt >= dayStart && m.createdAt <= dayEnd).length);
      leadCounts.push(leads.filter(l => l.createdAt >= dayStart && l.createdAt <= dayEnd).length);
    }

    res.json({ success: true, chartData: { labels, messageCounts, leadCounts } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics.' });
  }
});


//  MANAGE SERVICE ZONES
app.put('/api/dashboard/service-areas', authenticateToken, async (req, res) => {
  try {
    const { areas } = req.body; // Expects an array of strings
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Save as JSON string
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { serviceAreas: JSON.stringify(areas) }
    });

    res.json({ success: true, message: 'Service zones updated!' });
  } catch (error) {
    console.error('❌ Update service areas error:', error);
    res.status(500).json({ error: 'Failed to update zones.' });
  }
});


// 🚀 FETCH AVAILABLE MODELS FOR A GIVEN PROVIDER
app.post('/api/fetch-models', authenticateToken, async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'Provider and API Key are required.' });
    }

    let models = [];

    // 1. HARDCODED FALLBACKS FOR PROVIDERS WITHOUT STANDARD /models ENDPOINTS
    if (provider === 'anthropic') {
      return res.json({ 
        success: true,
        models: [
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', isRecommended: true },
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', isRecommended: false }
        ] 
      });
    } 
    
    if (provider === 'google') {
      return res.json({
        success: true,
        models: [
          { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', isRecommended: true },
          { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', isRecommended: false }
        ]
      });
    }

    // 2. DEFINE BASE URL FOR FETCHABLE PROVIDERS
    let baseUrl = '';
    if (provider === 'openai') {
      baseUrl = 'https://api.openai.com/v1';
    } else if (provider === 'deepseek') {
      baseUrl = 'https://api.deepseek.com/v1';
    } else if (provider === 'alibaba' || provider === 'qwen') {
      baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    } else if (provider === 'groq') {
      baseUrl = 'https://api.groq.com/openai/v1';
    } else {
      return res.status(400).json({ error: 'Unsupported provider for model fetching.' });
    }

    // 3. FETCH MODELS FROM PROVIDER
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (response.ok) {
        const data = await response.json();
        const rawModels = data.data || [];
        
        models = rawModels.map(m => {
          const isRecommended = m.id.includes('gpt-4o') || m.id.includes('deepseek-chat') || m.id.includes('llama-3') || m.id.includes('qwen-plus');
          return { id: m.id, name: m.id, isRecommended: isRecommended };
        }).filter(m => 
          m.id.includes('chat') || m.id.includes('gpt') || m.id.includes('qwen') || 
          m.id.includes('deepseek') || m.id.includes('llama') || m.id.includes('claude') || m.id.includes('gemini')
        );

        models.sort((a, b) => (b.isRecommended === a.isRecommended) ? 0 : b.isRecommended ? 1 : -1);
        models = models.slice(0, 20); // Limit to top 20
      }
    } catch (fetchError) {
      console.log('Fetch models endpoint failed, using fallbacks:', fetchError.message);
    }

    // 4. FINAL FALLBACK IF FETCH FAILED BUT KEY MIGHT BE VALID
    if (models.length === 0) {
      if (provider === 'openai') {
        models = [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini', isRecommended: true }, { id: 'gpt-4o', name: 'GPT-4o', isRecommended: false }];
      } else if (provider === 'deepseek') {
        models = [{ id: 'deepseek-chat', name: 'DeepSeek V3', isRecommended: true }];
      } else if (provider === 'alibaba' || provider === 'qwen') {
        models = [{ id: 'qwen-plus', name: 'Qwen Plus', isRecommended: true }, { id: 'qwen-max', name: 'Qwen Max', isRecommended: false }];
      } else if (provider === 'groq') {
        models = [{ id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B', isRecommended: true }];
      }
    }

    if (models.length === 0) {
      return res.status(400).json({ error: 'No chat models found. Please check your API Key.' });
    }

    res.json({ success: true, models });
  } catch (error) {
    console.error('Fetch models error:', error);
    res.status(500).json({ error: 'Failed to fetch models.' });
  }
});

// 🚀 TEAM: Invite Agent to Tenant
app.post('/api/dashboard/team/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    // Check if user exists
    const userToAdd = await prisma.user.findUnique({ where: { email } });
    if (!userToAdd) {
      return res.status(404).json({ error: 'User with this email does not exist. They must register first.' });
    }

    // Check if already added as team member
    const existingMember = await prisma.teamMember.findFirst({
      where: { 
        tenantId: tenant.id, 
        userId: userToAdd.id 
      }
    });

    if (existingMember) {
      return res.status(400).json({ error: 'This user is already a team member.' });
    }

    // Add as team member
    await prisma.teamMember.create({
      data: { 
        tenantId: tenant.id, 
        userId: userToAdd.id, 
        role: 'AGENT' 
      }
    });

    res.json({ success: true, message: 'Agent invited successfully!' });
  } catch (error) {
    console.error('❌ Invite agent error:', error);
    res.status(500).json({ error: 'Failed to invite agent.' });
  }
});

// 🚀 TEAM: Get Team Members
app.get('/api/dashboard/team', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const members = await prisma.teamMember.findMany({
      where: { tenantId: tenant.id },
      include: { 
        user: { 
          select: { 
            id: true,
            email: true,
            role: true 
          } 
        } 
      }
    });

    res.json({ success: true, members });
  } catch (error) {
    console.error('❌ Fetch team error:', error);
    res.status(500).json({ error: 'Failed to fetch team members.' });
  }
});


//  ACCEPT INVITATION: Create account + add to team
app.post('/api/auth/accept-invitation', async (req, res) => {
  try {
    const { email, token, password } = req.body;
    if (!email || !token || !password) {
      return res.status(400).json({ error: 'Email, token, and password are required.' });
    }

    // Verify invitation
    const invitation = await prisma.teamInvitation.findFirst({
      where: { email, token, accepted: false, expiresAt: { gt: new Date() } },
      include: { tenant: { select: { id: true, businessName: true } } }
    });

    if (!invitation) {
      return res.status(400).json({ error: 'Invalid or expired invitation link.' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists. Please log in instead.' });
    }

    // Create user with AGENT role
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: { 
        email, 
        password: hashedPassword, 
        role: 'AGENT' //  CRITICAL: Set role to AGENT, not TENANT
      }
    });

    // Add to team
    await prisma.teamMember.create({
      data: { tenantId: invitation.tenantId, userId: newUser.id, role: 'AGENT' }
    });

    // Mark invitation as accepted
    await prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: { accepted: true }
    });

    // Generate JWT token for login
    const jwt = require('jsonwebtoken');
    const authToken = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      { expiresIn: '7d' }
    );

    res.json({ 
      success: true, 
      message: 'Account created and added to team!',
      token: authToken,
      user: { email: newUser.email, role: newUser.role }
    });
  } catch (error) {
    console.error('❌ Accept invitation error:', error);
    res.status(500).json({ error: 'Failed to accept invitation.' });
  }
});


//  AGENT: Get team chats
app.get('/api/agent/chats', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ 
      where: { id: req.user.userId },
      include: { 
        teamMemberships: { 
          include: { 
            tenant: { 
              include: { 
                messages: {
                  orderBy: { createdAt: 'desc' },
                  take: 50
                }
              }
            }
          }
        }
      }
    });

    if (!user || user.teamMemberships.length === 0) {
      return res.status(404).json({ error: 'No team access found.' });
    }

    // Get all messages from tenant(s)
    const allMessages = [];
    user.teamMemberships.forEach(membership => {
      allMessages.push(...membership.tenant.messages);
    });

    // Group by phone number
    const chatsMap = new Map();
    allMessages.forEach(msg => {
      if (msg.direction === 'inbound') {
        if (!chatsMap.has(msg.fromNumber)) {
          chatsMap.set(msg.fromNumber, {
            phoneNumber: msg.fromNumber,
            lastMessage: msg.content,
            createdAt: msg.createdAt
          });
        }
      }
    });

    const chats = Array.from(chatsMap.values()).sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json({ success: true, chats });
  } catch (error) {
    console.error(' Agent chats error:', error);
    res.status(500).json({ error: 'Failed to load chats.' });
  }
});

// 🚀 AGENT: Send message
app.post('/api/agent/send-message', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'Phone number and message are required.' });
    }

    const user = await prisma.user.findUnique({ 
      where: { id: req.user.userId },
      include: { teamMemberships: true }
    });

    if (!user || user.teamMemberships.length === 0) {
      return res.status(403).json({ error: 'No team access.' });
    }

    // Get first tenant's WhatsApp number (for MVP)
    const tenantId = user.teamMemberships[0].tenantId;
    const tenant = await prisma.tenant.findUnique({ 
      where: { id: tenantId },
      select: { whatsappNumber: true }
    });

    // Save message to database
    await prisma.message.create({
      data: {
        tenantId,
        fromNumber: tenant.whatsappNumber,
        toNumber: phoneNumber,
        direction: 'outbound',
        content: message,
        isAiReply: false
      }
    });

    // Send via WhatsApp (using activeSockets map)
    const sock = activeSockets.get(tenant.whatsappNumber);
    if (sock) {
      await sock.sendMessage(phoneNumber + '@s.whatsapp.net', { text: message });
      res.json({ success: true, message: 'Message sent!' });
    } else {
      res.status(500).json({ error: 'WhatsApp session not active.' });
    }
  } catch (error) {
    console.error(' Agent send message error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

//  Serve agent dashboard
app.get('/agent-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'agent-dashboard.html'));
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

