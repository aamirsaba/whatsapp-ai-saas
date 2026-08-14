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
      await prisma.tenant.update({ where: { id: tenantId }, data: { isActive: true } });
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

      // 🚀 NEW: Auto-Create Lead in CRM if it's a new customer
      const existingLead = await prisma.lead.findFirst({
        where: { tenantId: tenant.id, phoneNumber: fromNumber }
      });

      if (!existingLead) {
        console.log(`🎯 New Lead Detected: ${fromNumber} | Adding to CRM...`);
        await prisma.lead.create({
          data: {
            tenantId: tenant.id,
            phoneNumber: fromNumber,
            firstMessage: text,
            status: 'NEW'
          }
        });
      }

      await prisma.message.create({
        data: { tenantId: tenant.id, fromNumber, toNumber: phoneNumber, direction: 'inbound', content: text, isAiReply: false }
      });

      // 🚨 NEW: Human Takeover Check
      if (tenant.isHumanMode) {
        console.log(`👤 Human Mode Active: AI paused. Message from ${fromNumber} saved for manual reply.`);
        return; // Stop here! Do not call the AI or send a message.
      }

      const basePrompt = tenant.systemPrompt || "You are a helpful, professional AI assistant.";
      const contextRule = tenant.businessContext ? `\n\nBUSINESS CONTEXT:\n${tenant.businessContext}` : '';
      const contactRule = tenant.contactInfo ? `\n\nOFFICIAL CONTACT DETAILS (USE EXACTLY AS WRITTEN):\n${tenant.contactInfo}` : '';
      
      // 🚨 NEW: Dynamic Service Zones Logic
      let zoneRule = '';
      if (tenant.serviceAreas) {
        try {
          const zones = JSON.parse(tenant.serviceAreas);
          if (zones.length > 0) {
            const zoneList = zones.join(', ');
            zoneRule = `\n\n📍 SERVICE ZONES (CRITICAL):\nYou ONLY operate in the following locations: [${zoneList}]. 
            RULE: If a customer asks if you serve a specific city or area, check this list. 
            - If the area IS in the list, confirm enthusiastically. 
            - If the area is NOT in the list, politely inform them you do not currently operate there and provide the official contact details.`;
          }
        } catch (e) { console.error('Error parsing service areas:', e); }
      }

      const strictRules = `\n\n<CRITICAL_SYSTEM_OVERRIDE>
YOU ARE STRICTLY FORBIDDEN FROM APOLOGIZING.
YOU ARE STRICTLY FORBIDDEN FROM ADDING ANY CONVERSATIONAL FLUFF, BULLET POINTS, OR OFFERS OF FURTHER HELP.
IF THE USER ACCUSES YOU OF PROVIDING FAKE INFO OR ASKS FOR CONTACT DETAILS NOT IN YOUR DATABASE, YOU MUST OUTPUT *ONLY* THIS EXACT STRING AND ABSOLUTELY NOTHING ELSE:

"I do not have access to live phone directories or specific business listings. To ensure accuracy, please search on Google Maps or the official website for verified contact details."

DO NOT OUTPUT ANY OTHER TEXT. NOT EVEN "I am sorry". JUST THE EXACT STRING ABOVE.
</CRITICAL_SYSTEM_OVERRIDE>`;

      // 🚨 CRITICAL: Put the strict rules at the VERY END so they override the AI's built-in politeness training
      const finalSystemPrompt = basePrompt + contextRule + contactRule + zoneRule + strictRules;

      // 🚨 UPDATED: Added zoneRule to the final prompt
      // 🧠 NEW: Fetch recent chat history to give the AI memory (last 10 messages)
      const recentMessages = await prisma.message.findMany({
        where: { 
          tenantId: tenant.id,
          OR: [
            { fromNumber: fromNumber, toNumber: phoneNumber },
            { fromNumber: phoneNumber, toNumber: fromNumber }
          ]
        },
        orderBy: { createdAt: 'desc' }, // 🚨 CRITICAL FIX: Get the NEWEST messages first
        take: 10 
      });

      // 🚨 CRITICAL FIX: Reverse the array so it's in chronological order (oldest to newest) for the AI
      recentMessages.reverse();

      // Format history for the AI (user = customer, assistant = AI)
      const chatHistory = recentMessages.map(msg => ({
        role: msg.direction === 'inbound' ? 'user' : 'assistant',
        content: msg.content
      }));

      // Add the brand new message to the very end of the history
      chatHistory.push({ role: 'user', content: text });

      // 🚨 PASS THE FULL HISTORY TO THE AI
      const aiReply = await getAIResponse(chatHistory, finalSystemPrompt, tenant);

      console.log(`🗣️ AI Reply: ${aiReply}`);

      await sock.sendMessage(msg.key.remoteJid, { text: aiReply });

      await prisma.message.create({
        data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiReply, isAiReply: true }
      });

      if (process.env.DISCORD_WEBHOOK_URL) {
        fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `🔥 **New WhatsApp Activity!**\n🏢 **Business:** ${tenant.businessName}\n📱 **Number:** ${fromNumber}\n💬 **Message:** ${text}\n🤖 **AI Reply:** ${aiReply}` })
        }).catch(err => console.error("❌ Failed to notify Discord:", err));
      }
    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets };