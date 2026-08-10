const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { PrismaClient } = require('@prisma/client');
const { getAIResponse } = require('./ai');

const prisma = new PrismaClient();
const activeSockets = new Map();

async function startWhatsAppSession(tenantId, phoneNumber, onQrGenerated, onConnected) {  
  console.log(`🔄 Starting WhatsApp session for: ${phoneNumber}`);

  const { state, saveCreds } = await useMultiFileAuthState(`./auth_info_${phoneNumber}`);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  activeSockets.set(phoneNumber, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`\n📱 SCAN THIS QR CODE WITH WHATSAPP FOR: ${phoneNumber}`);
      qrcode.generate(qr, { small: true });
      
      if (onQrGenerated) {
        onQrGenerated(phoneNumber, qr);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppSession(tenantId, phoneNumber, onQrGenerated, onConnected);
      }
    } else if (connection === 'open') {
      console.log(`✅ SUCCESS! WhatsApp is connected and ready for: ${phoneNumber}`);
      
      if (onConnected) {
        onConnected(phoneNumber);
      }
      
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { isActive: true }
      });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    
    const rawJid = msg.key.remoteJid;
    const isIndividualChat = rawJid.endsWith('@s.whatsapp.net') || rawJid.endsWith('@lid');
    if (!isIndividualChat) return;

    const jidForNumber = msg.key.remoteJidAlt || rawJid;
    const fromNumber = jidForNumber.replace(/@(s\.whatsapp\.net|lid)/, '');

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    if (!text) return;

    console.log(`\n📩 [SUCCESS] New Message from ${fromNumber}: ${text}`);

    try {
      const tenant = await prisma.tenant.findUnique({ where: { whatsappNumber: phoneNumber } });
      if (!tenant) {
        console.log("❌ [DEBUG] Tenant NOT FOUND in database for this number.");
        return;
      }

      await prisma.message.create({
        data: { tenantId: tenant.id, fromNumber, toNumber: phoneNumber, direction: 'inbound', content: text, isAiReply: false }
      });

      // 🧠 Build the prompt with Anti-Hallucination Shield
      const basePrompt = tenant.systemPrompt || "You are a helpful, professional AI assistant.";
      
      const contextRule = tenant.businessContext 
        ? `\n\nBUSINESS CONTEXT:\n${tenant.businessContext}` 
        : '';
        
      const contactRule = tenant.contactInfo 
        ? `\n\nOFFICIAL CONTACT DETAILS (USE EXACTLY AS WRITTEN):\n${tenant.contactInfo}` 
        : '';

      const strictRules = `\n\n🚨 STRICT ANTI-HALLUCINATION RULES (DO NOT BREAK):
1. You MUST strictly answer questions related ONLY to the provided BUSINESS CONTEXT and CONTACT DETAILS.
2. DO NOT invent, guess, or make up phone numbers, email addresses, website URLs, prices, or people's names.
3. If a user asks for specific contact details that are marked as "Not provided" or are missing from the OFFICIAL CONTACT DETAILS above, you MUST reply exactly with: "I don't have that specific information in my database. Please reach out to our official support channels for accurate details."
4. Keep responses concise, professional, and directly aligned with the provided facts.`;

      const finalSystemPrompt = basePrompt + contextRule + contactRule + strictRules;

      const aiReply = await getAIResponse(text, finalSystemPrompt, tenant);
      console.log(`🗣️ AI Reply: ${aiReply}`);

      await sock.sendMessage(msg.key.remoteJid, { text: aiReply });

      await prisma.message.create({
        data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiReply, isAiReply: true }
      });

      // 🚀 Discord Webhook
      if (process.env.DISCORD_WEBHOOK_URL) {
        fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🔥 **New WhatsApp Activity!**\n🏢 **Business:** ${tenant.businessName}\n📱 **Number:** ${fromNumber}\n💬 **Message:** ${text}\n🤖 **AI Reply:** ${aiReply}`
          })
        }).catch(err => console.error("❌ Failed to notify Discord:", err));
      }

    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets };