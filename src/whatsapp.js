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
      console.log("️ [DEBUG] Ignored: Not an individual chat. JID:", rawJid);
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
        console.log(" [DEBUG] Tenant NOT FOUND in database for this number.");
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
      
      // 🧠 NEW: Build a strict, context-aware system prompt
      const basePrompt = tenant.systemPrompt || "You are a helpful AI assistant.";
      const contextInstruction = tenant.businessContext 
        ? `\n\nCRITICAL BUSINESS CONTEXT: ${tenant.businessContext}\n\nYou are representing ${tenant.businessName}. You MUST strictly answer questions related ONLY to this business context. If a user asks about unrelated topics (like general knowledge, other businesses, or random facts), politely decline and state that you can only assist with matters related to ${tenant.businessName}.` 
        : "";
        
      const finalSystemPrompt = basePrompt + contextInstruction;

      // Pass the new smart prompt to the AI
      const aiReply = await getAIResponse(text, finalSystemPrompt, tenant); // <-- Added 'tenant' here!
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

      // 🚀 Send Beautiful Lead Alert to Discord
      console.log("📡 Sending lead alert to Discord...");
      if (process.env.DISCORD_WEBHOOK_URL) {
        fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🔥 **New WhatsApp Activity!**\n🏢 **Business:** ${tenant.businessName}\n📱 **Number:** ${fromNumber}\n💬 **Message:** ${text}\n **AI Reply:** ${aiReply}`
          })
        }).catch(err => console.error("❌ Failed to notify Discord:", err));
      }

    } catch (error) {
      console.error(" Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets };