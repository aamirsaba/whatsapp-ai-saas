require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { startWhatsAppSession } = require('./whatsapp');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const prisma = new PrismaClient();
app.use(express.json());


const { registerUser, loginUser } = require('./auth');

// ... (keep your existing QR code and WebSocket code here) ...

// 🚀 AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, businessName, whatsappNumber, businessContext } = req.body;
    
    // 🚀 ENFORCE BUSINESS CONTEXT
    if (!email || !password || !businessName || !whatsappNumber || !businessContext) {
      return res.status(400).json({ error: 'Email, password, business name, WhatsApp number, and Business Context are all required.' });
    }
    
    const result = await registerUser(email, password, businessName, whatsappNumber);
    res.status(201).json({ success: true, message: 'Account created!', ...result });
  } catch (error) {
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

// 🧠 CACHE TO REMEMBER THE LATEST QR CODE FOR EACH NUMBER
const qrCache = {};

// 🌐 WEBSOCKET: SEND CACHED QR CODE TO NEW CONNECTIONS IMMEDIATELY
wss.on('connection', (ws) => {
  for (const [num, qr] of Object.entries(qrCache)) {
    ws.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num }));
  }
});

// 🌐 CUSTOMER-FACING QR CODE PAGE
app.get('/connect/:phoneNumber', (req, res) => {
  const { phoneNumber } = req.params;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Connect WhatsApp</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #111; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px; width: 90%; }
        h1 { font-size: 24px; margin-bottom: 10px; }
        .phone { color: #00a884; font-size: 20px; font-weight: bold; margin-bottom: 20px; }
        #qrcode { margin: 20px auto; padding: 15px; background: white; border: 1px solid #ddd; border-radius: 8px; display: inline-block; }
        .instructions { text-align: left; line-height: 1.8; margin-top: 20px; font-size: 14px; color: #555; }
        .status { margin-top: 20px; padding: 12px; border-radius: 8px; font-weight: bold; font-size: 14px; }
        .waiting { background: #e9edef; color: #54656f; }
        .success { background: #d9fdd3; color: #1f7a2c; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Link your WhatsApp</h1>
        <div class="phone">${phoneNumber}</div>
        <div id="qrcode"><p style="color: #888; padding: 50px;">Generating QR Code...</p></div>
        <div class="instructions">
          <strong>How to link:</strong><br>
          1. Open WhatsApp on your phone<br>
          2. Tap <strong>⋮</strong> or <strong>Settings</strong> > <strong>Linked Devices</strong><br>
          3. Tap <strong>Link a Device</strong><br>
          4. Point your phone at this screen to scan the code
        </div>
        <div id="status" class="status waiting">⏳ Waiting for QR code...</div>
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
          }
          if (data.type === 'success' && data.phoneNumber === '${phoneNumber}') {
            document.getElementById('status').className = 'status success';
            document.getElementById('status').textContent = '✅ Connected successfully! Your AI is now active.';
            document.getElementById('qrcode').innerHTML = '<div style="font-size: 60px; color: #00a884;">✓</div>';
          }
        };
      </script>
    </body>
    </html>
  `);
});

// 🌐 Serve the beautiful customer portal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

//  Serve the Login Page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Helper function to handle QR and Success callbacks with caching
const handleQr = (num, qr) => {
  qrCache[num] = qr; // Save to cache
  wss.clients.forEach(client => { 
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num })); 
    }
  });
};

const handleSuccess = (num) => {
  delete qrCache[num]; // Clear cache on success
  wss.clients.forEach(client => { 
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'success', phoneNumber: num })); 
    }
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
        systemPrompt: "أنت مساعد ذكي ولطيف لـ " + businessName + ". رد باختصار وبشكل احترافي. يمكنك التحدث بالعربية أو الإنجليزية حسب لغة العميل."
      }
    });

    startWhatsAppSession(tenant.id, formattedNumber, handleQr, handleSuccess);

    res.json({ success: true, message: "Session started. Visit /connect/" + formattedNumber + " to scan.", tenantId: tenant.id });
  } catch (error) {
    console.error("❌ Connection Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/register-tenant', async (req, res) => {
  try {
    // 1. Grab ALL the new fields from the frontend form
    const { 
      businessName, 
      whatsappNumber, 
      systemPrompt, 
      businessContext, 
      llmProvider, 
      llmApiKey, 
      llmModel 
    } = req.body;

    if (!businessName || !whatsappNumber) {
      return res.status(400).json({ error: 'businessName and whatsappNumber are required' });
    }
    
    // 2. Save them all to the database
    const newTenant = await prisma.tenant.create({
      data: { 
        businessName, 
        whatsappNumber, 
        systemPrompt: systemPrompt || 'You are a helpful AI assistant.',
        businessContext: businessContext || null,       // NEW: Save business context
        llmProvider: llmProvider || 'QWEN',             // NEW: Default to Qwen
        llmApiKey: llmApiKey || null,                   // NEW: Save custom API key if provided
        llmModel: llmModel || null,                     // NEW: Save custom model name if provided
        isActive: true 
      }
    });
    
    startWhatsAppSession(newTenant.id, newTenant.whatsappNumber,
      (num, qr) => { wss.clients.forEach(client => { if (client.readyState === 1) client.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num })); }); },
      (num) => { wss.clients.forEach(client => { if (client.readyState === 1) client.send(JSON.stringify({ type: 'success', phoneNumber: num })); }); }
    );
    
    res.status(201).json({ 
      success: true, 
      message: 'Tenant registered. Visit /connect/' + newTenant.whatsappNumber, 
      tenantId: newTenant.id 
    });
  } catch (error) {
    console.error('❌ Error registering tenant:', error); 
    res.status(500).json({ error: 'Failed to register tenant', details: error.message });
  }
});
app.get('/api/tenants', async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({ select: { id: true, businessName: true, whatsappNumber: true, isActive: true, createdAt: true } });
    res.json({ success: true, count: tenants.length, tenants });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

app.post('/api/start-sessions', async (req, res) => {
  try {
    const activeTenants = await prisma.tenant.findMany({ where: { isActive: true } });
    for (const tenant of activeTenants) {
      startWhatsAppSession(tenant.id, tenant.whatsappNumber, handleQr, handleSuccess);
    }
    res.json({ success: true, message: `Started ${activeTenants.length} session(s). Visit /connect/[number] to scan.` });
  } catch (error) {
    res.status(500).json({ error: "Failed to start sessions", details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp AI SaaS Backend is running!`);
  console.log(`🌐 Server running on http://localhost:${PORT}`);
  console.log(`⚡ Customer QR Page: https://bot.aamirsaba.com/connect/96891293119`);
});