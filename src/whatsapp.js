const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { PrismaClient } = require('@prisma/client');
const { getAIResponse } = require('./ai');

const prisma = new PrismaClient();
const activeSockets = new Map();

async function startWhatsAppSession(tenantId, phoneNumber) {
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
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppSession(tenantId, phoneNumber);
      }
    } else if (connection === 'open') {
      console.log(`✅ SUCCESS! WhatsApp is connected and ready for: ${phoneNumber}`);
      
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { isActive: true }
      });
    }
  });

  // Listen for incoming messages with MAXIMUM DEBUG
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log("🔔 [DEBUG] Event fired! Type:", type);
    
    if (type !== 'notify') {
      console.log("⏭️ [DEBUG] Ignored: type is not 'notify'");
      return;
    }

    const msg = messages[0];
    console.log("🔔 [DEBUG] Message Key:", msg.key);

    if (!msg.message) {
      console.log("⏭️ [DEBUG] Ignored: no msg.message (e.g., read receipt)");
      return;
    }
    
    if (msg.key.fromMe) {
      console.log("⏭️ [DEBUG] Ignored: fromMe is true (message sent by bot)");
      return;
    }
    
    const rawJid = msg.key.remoteJid;
    console.log("🔔 [DEBUG] rawJid:", rawJid);
    
    const isIndividualChat = rawJid.endsWith('@s.whatsapp.net') || rawJid.endsWith('@lid');
    if (!isIndividualChat) {
      console.log("⏭️ [DEBUG] Ignored: Not an individual chat. JID:", rawJid);
      return;
    }

    const jidForNumber = msg.key.remoteJidAlt || rawJid;
    const fromNumber = jidForNumber.replace(/@(s\.whatsapp\.net|lid)/, '');
    console.log("🔔 [DEBUG] Extracted fromNumber:", fromNumber);

    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || "";

    if (!text) {
      console.log("⏭️ [DEBUG] Ignored: No text found in message");
      return;
    }

    console.log(`\n📩 [SUCCESS] New Message from ${fromNumber}: ${text}`);

    try {
      console.log("🔔 [DEBUG] Looking up tenant in DB for number:", phoneNumber);
      const tenant = await prisma.tenant.findUnique({ where: { whatsappNumber: phoneNumber } });
      if (!tenant) {
        console.log("❌ [DEBUG] Tenant NOT FOUND in database for this number.");
        return;
      }
      console.log("✅ [DEBUG] Tenant found:", tenant.businessName);

      await prisma.message.create({
        data: {
          tenantId: tenant.id,
          fromNumber,
          toNumber: phoneNumber,
          direction: 'inbound',
          content: text,
          isAiReply: false
        }
      });

      console.log("🤖 Thinking...");
      const aiReply = await getAIResponse(text, tenant.systemPrompt);
      console.log(`🗣️ AI Reply: ${aiReply}`);

      await sock.sendMessage(msg.key.remoteJid, { text: aiReply });

      await prisma.message.create({
        data: {
          tenantId: tenant.id,
          fromNumber: phoneNumber,
          toNumber: fromNumber,
          direction: 'outbound',
          content: aiReply,
          isAiReply: true
        }
      });

      console.log("📡 Sending lead alert to n8n...");
      fetch('http://localhost:5678/webhook/new-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: tenant.businessName,
          leadPhone: fromNumber,
          leadMessage: text,
          aiReply: aiReply,
          timestamp: new Date().toISOString()
        })
      }).catch(err => console.error("Failed to notify n8n:", err));

    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets };