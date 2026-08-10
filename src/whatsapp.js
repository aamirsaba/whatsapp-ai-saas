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
      if (onQrGenerated) onQrGenerated(phoneNumber, qr);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppSession(tenantId, phoneNumber, onQrGenerated, onConnected);
      }
    } else if (connection === 'open') {
      console.log(`✅ SUCCESS! WhatsApp is connected and ready for: ${phoneNumber}`);
      if (onConnected) onConnected(phoneNumber);
      
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

      const basePrompt = tenant.systemPrompt || "You are a helpful AI assistant.";
      const contextInstruction = tenant.businessContext 
        ? `\n\nCRITICAL BUSINESS CONTEXT: ${tenant.businessContext}\n\nYou are representing ${tenant.businessName}. You MUST strictly answer questions related ONLY to this business context.` 
        : "";
        
      const aiReply = await getAIResponse(text, basePrompt + contextInstruction, tenant);
      console.log(`🗣️ AI Reply: ${aiReply}`);

      await sock.sendMessage(msg.key.remoteJid, { text: aiReply });

      await prisma.message.create({
        data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiReply, isAiReply: true }
      });

      // 🚨 NEW: Robust Discord Webhook Logging
      console.log("📡 Checking Discord Webhook...");
      if (process.env.DISCORD_WEBHOOK_URL) {
        console.log("📡 Sending lead alert to Discord...");
        
        fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🔥 **New WhatsApp Activity!**\n🏢 **Business:** ${tenant.businessName}\n📱 **Number:** ${fromNumber}\n💬 **Message:** ${text}\n🤖 **AI Reply:** ${aiReply}`
          })
        })
        .then(res => {
          if (!res.ok) {
            console.error(`❌ Discord Webhook HTTP Error: ${res.status} ${res.statusText}`);
          } else {
            console.log("✅ Discord Webhook sent successfully!");
          }
        })
        .catch(err => console.error("❌ Failed to notify Discord (Network Error):", err));
      } else {
        console.log("⚠️ DISCORD_WEBHOOK_URL is MISSING in your .env file!");
      }

    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets };