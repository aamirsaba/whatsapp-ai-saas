const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcodeTerminal = require('qrcode-terminal');
const { toDataURL } = require('qrcode');
const pino = require('pino');
const { PrismaClient } = require('@prisma/client');
const { getAIResponse } = require('./ai');
const { getPolicyForTenant } = require('./policies');

const prisma = new PrismaClient();
const activeSockets = new Map();
const qrCodes = new Map();

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
      console.log(`\n SCAN THIS QR CODE WITH WHATSAPP FOR: ${phoneNumber}`);
      qrcodeTerminal.generate(qr, { small: true });
      
      try {
        const qrDataUrl = await toDataURL(qr);
        qrCodes.set(phoneNumber, qrDataUrl);
      } catch (err) {
        console.error('Failed to generate QR Data URL:', err);
      }
      
      if (onQrGenerated) onQrGenerated(phoneNumber, qr);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
      
      if (!shouldReconnect) {
        qrCodes.delete(phoneNumber);
        activeSockets.delete(phoneNumber);
        await prisma.tenant.updateMany({ 
          where: { whatsappNumber: phoneNumber }, 
          data: { isActive: false } 
        }).catch(() => {});
      }
      
      if (shouldReconnect) {
        startWhatsAppSession(tenantId, phoneNumber, onQrGenerated, onConnected);
      }
    } else if (connection === 'open') {
      console.log(`✅ SUCCESS! WhatsApp is connected and ready for: ${phoneNumber}`);
      qrCodes.delete(phoneNumber);
      if (onConnected) onConnected(phoneNumber);
      await prisma.tenant.updateMany({ 
        where: { id: tenantId }, 
        data: { isActive: true } 
      }).catch(() => {});
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

    console.log(`\n [SUCCESS] New Message from ${fromNumber}: ${text}`);

    try {
      const tenant = await prisma.tenant.findUnique({ where: { whatsappNumber: phoneNumber } });
      if (!tenant) {
        console.log("❌ [DEBUG] Tenant NOT FOUND in database for this number.");
        return;
      }

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

      if (tenant.isHumanMode) {
        console.log(` Human Mode Active: AI paused. Message from ${fromNumber} saved for manual reply.`);
        return;
      }

      const basePrompt = tenant.systemPrompt || "You are a helpful, professional AI assistant.";
      
      let contextRule = '';
      if (tenant.businessContext) {
        contextRule += `\n\nBUSINESS CONTEXT:\n${tenant.businessContext}`;
      }
      if (tenant.knowledgeBase) {
        contextRule += `\n\n📄 KNOWLEDGE BASE (USE THIS DATA TO ANSWER QUESTIONS):\n${tenant.knowledgeBase}`;
      }
      
      // 🚨 STRENGTHENED: Force the AI to use the contact info
      const contactRule = tenant.contactInfo 
        ? `\n\n🚨 CRITICAL RULE: If the user asks for contact details, phone number, email, address, or website, you MUST provide the exact information below. DO NOT say you don't have access, and DO NOT tell them to search Google.\n\nOFFICIAL CONTACT DETAILS:\n${tenant.contactInfo}` 
        : '';
      
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

      const activePolicy = getPolicyForTenant(tenant.businessContext || tenant.industry || '');
      
      const currentYear = new Date().getFullYear();
      const timeContext = `\n\n⏰ CURRENT TIME CONTEXT: The current year is ${currentYear}. When providing market data, prices, or trends, you must frame them as current as of ${currentYear}. Do not default to outdated years like 2023 or 2024. If you lack real-time ${currentYear} data, state: "While I don't have live ${currentYear} market feeds, historically this area trends around..."`;

      // 🚨 THE ONLY CHANGE: contactRule is now at the VERY END so the AI cannot ignore it
      const finalSystemPrompt = timeContext + basePrompt + contextRule + zoneRule + activePolicy + contactRule;

      const recentMessages = await prisma.message.findMany({
        where: { 
          tenantId: tenant.id,
          OR: [
            { fromNumber: fromNumber, toNumber: phoneNumber },
            { fromNumber: phoneNumber, toNumber: fromNumber }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 10 
      });

      recentMessages.reverse();

      const chatHistory = recentMessages.map(msg => ({
        role: msg.direction === 'inbound' ? 'user' : 'assistant',
        content: msg.content
      }));

      chatHistory.push({ role: 'user', content: text });

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
          body: JSON.stringify({ content: `🔥 **New WhatsApp Activity!**\n🏢 **Business:** ${tenant.businessName}\n📱 **Number:** ${fromNumber}\n💬 **Message:** ${text}\n **AI Reply:** ${aiReply}` })
        }).catch(err => console.error("❌ Failed to notify Discord:", err));
      }
    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets, qrCodes };