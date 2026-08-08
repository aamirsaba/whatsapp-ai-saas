require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { startWhatsAppSession } = require('./whatsapp');

const app = express();
const prisma = new PrismaClient();

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('🚀 WhatsApp AI SaaS Backend is running!');
});

// Endpoint to register a business and start the QR code flow
app.post('/api/connect', async (req, res) => {
  try {
    const { businessName, whatsappNumber } = req.body;

    // Format phone number to ensure it has country code (e.g., 968 for Oman)
    const formattedNumber = whatsappNumber.replace(/\D/g, ''); 

    // 1. Create or Update Tenant in Database
    const tenant = await prisma.tenant.upsert({
      where: { whatsappNumber: formattedNumber },
      update: { businessName },
      create: { 
        businessName, 
        whatsappNumber: formattedNumber,
        systemPrompt: "أنت مساعد ذكي ولطيف لـ " + businessName + ". رد باختصار وبشكل احترافي. يمكنك التحدث بالعربية أو الإنجليزية حسب لغة العميل. (You are a smart, polite AI assistant for " + businessName + ". Reply concisely and professionally. You can speak Arabic or English based on the customer's language.)"
      }
    });

    // 2. Start the WhatsApp Session (This will print QR to terminal)
    startWhatsAppSession(tenant.id, formattedNumber);

    res.json({ 
      success: true, 
      message: "Session started. Check your terminal for the QR code to scan.",
      tenantId: tenant.id 
    });

  } catch (error) {
    console.error("❌ Connection Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📝 API Endpoint: Register a new tenant and start their WhatsApp session
app.post('/api/register-tenant', async (req, res) => {
  try {
    const { businessName, whatsappNumber, systemPrompt } = req.body;
    
    // Validate required fields
    if (!businessName || !whatsappNumber) {
      return res.status(400).json({ error: 'businessName and whatsappNumber are required' });
    }
    
    // Create new tenant in database
    const newTenant = await prisma.tenant.create({
      data: {
        businessName,
        whatsappNumber,
        systemPrompt: systemPrompt || 'You are a helpful AI assistant.',
        isActive: true
      }
    });
    
    console.log(`✅ New tenant registered: ${newTenant.businessName} (${newTenant.whatsappNumber})`);
    
    // 🚀 FIX: Use newTenant.whatsappNumber (not the undefined variable)
    console.log(`🔄 Starting WhatsApp session for new tenant...`);
    startWhatsAppSession(newTenant.id, newTenant.whatsappNumber);
    
    res.status(201).json({
      success: true,
      message: 'Tenant registered successfully. Please scan the QR code in the logs.',
      tenantId: newTenant.id,
      whatsappNumber: newTenant.whatsappNumber
    });
    
  } catch (error) {
    // Print the REAL error to the console so we can see exactly what went wrong
    console.error('❌ Error registering tenant:', error); 
    res.status(500).json({ error: 'Failed to register tenant', details: error.message });
  }
});

// 📊 API Endpoint: Get all active tenants (for admin dashboard)
app.get('/api/tenants', async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      select: {
        id: true,
        businessName: true,
        whatsappNumber: true,
        isActive: true,
        createdAt: true
      }
    });
    
    res.json({ success: true, count: tenants.length, tenants });
  } catch (error) {
    console.error(' Error fetching tenants:', error);
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp AI SaaS Backend is running!`);
  console.log(`🌐 Server running on http://localhost:${PORT}`);
  
  // 🚀 AUTO-START: Delay slightly to let Hostinger's environment stabilize
  setTimeout(async () => {
    console.log("🔄 Loading active tenants from database...");
    try {
      const activeTenants = await prisma.tenant.findMany({
        where: { isActive: true }
      });
      
      console.log(`✅ Found ${activeTenants.length} active tenant(s)`);
      
      for (const tenant of activeTenants) {
        console.log(`📱 Starting session for: ${tenant.whatsappNumber} (${tenant.businessName})`);
        startWhatsAppSession(tenant.id, tenant.whatsappNumber);
      }
    } catch (error) {
      console.error("⚠️ Error loading tenants on boot (server will still run):", error.message);
    }
  }, 2000); // 2-second delay prevents Prisma "timer has gone away" panic
});