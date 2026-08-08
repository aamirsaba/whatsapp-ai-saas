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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
});