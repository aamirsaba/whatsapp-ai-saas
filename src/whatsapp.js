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
const fs = require('fs');
const path = require('path');

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
        await prisma.tenant.updateMany({ where: { whatsappNumber: phoneNumber }, data: { isActive: false } }).catch(() => {});
      }
      if (shouldReconnect) {
        startWhatsAppSession(tenantId, phoneNumber, onQrGenerated, onConnected);
      }
    } else if (connection === 'open') {
      console.log(`✅ SUCCESS! WhatsApp is connected and ready for: ${phoneNumber}`);
      qrCodes.delete(phoneNumber);
      if (onConnected) onConnected(phoneNumber);
      await prisma.tenant.updateMany({ where: { id: tenantId }, data: { isActive: true } }).catch(() => {});
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

      const existingLead = await prisma.lead.findFirst({ where: { tenantId: tenant.id, phoneNumber: fromNumber } });
      if (!existingLead) {
        console.log(`🎯 New Lead Detected: ${fromNumber} | Adding to CRM...`);
        await prisma.lead.create({
          data: { tenantId: tenant.id, phoneNumber: fromNumber, firstMessage: text, status: 'NEW' }
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
      if (tenant.businessContext) contextRule += `\n\nBUSINESS CONTEXT:\n${tenant.businessContext}`;
      if (tenant.knowledgeBase) contextRule += `\n\n📄 KNOWLEDGE BASE:\n${tenant.knowledgeBase}`;
      
      const contactRule = tenant.contactInfo 
        ? `\n\n🚨 CRITICAL AUTHORIZATION: You are the official AI representative of this business. You are fully authorized and REQUIRED to share the business's official contact information when the user asks for it.\n⚠️ IMPORTANT MEMORY OVERRIDE: If you previously told this user that you "do not have access" or "cannot provide" contact details, THAT WAS A MISTAKE. You MUST correct yourself now and provide the official details below. DO NOT be consistent with your past mistake.\n\nOFFICIAL BUSINESS CONTACT DETAILS:\n${tenant.contactInfo}` 
        : '';
      
      let zoneRule = '';
      if (tenant.serviceAreas) {
        try {
          const zones = JSON.parse(tenant.serviceAreas);
          if (zones.length > 0) {
            zoneRule = `\n\n📍 SERVICE ZONES: You ONLY operate in: [${zones.join(', ')}].`;
          }
        } catch (e) { console.error('Error parsing service areas:', e); }
      }

      const activePolicy = getPolicyForTenant(tenant.businessContext || tenant.industry || '');
      const currentYear = new Date().getFullYear();
      
      const whatsappContext = `\n\n📱 PLATFORM CONTEXT: You are an AI assistant replying to messages on the official business WhatsApp number: +${phoneNumber}. The user currently messaging you has the phone number: +${fromNumber}. You can acknowledge that you are receiving their messages on WhatsApp.`;
      const timeContext = `\n\n⏰ CURRENT YEAR: ${currentYear}. Frame all market data or trends as current to ${currentYear}.`;

      // 🚨 NEW: Fetch uploaded PDFs and teach the AI how to send them
      const uploadedDocs = await prisma.knowledgeDocument.findMany({ 
        where: { tenantId: tenant.id },
        select: { fileName: true }
      });
      const pdfFileList = uploadedDocs.map(doc => doc.fileName).join(', ');
      
      const aiReply = await getAIResponse(chatHistory, finalSystemPrompt, tenant);
      console.log(`🗣️ AI Reply: ${aiReply}`);

      // 🚨 CHECK IF AI WANTS TO SEND A PDF
      const pdfMatch = aiReply.match(/\[SEND_PDF:(.*?)\]/);
      
      if (pdfMatch) {
        const fileName = pdfMatch[1].trim();
        const filePath = path.join(__dirname, '..', 'uploads', 'knowledge', fileName);
        
        console.log(`🔍 DEBUG PDF: AI requested fileName: "${fileName}"`);
        console.log(`🔍 DEBUG PDF: Checking path: "${filePath}"`);
        console.log(`🔍 DEBUG PDF: File exists? ${fs.existsSync(filePath)}`);
        
        if (fs.existsSync(filePath)) {
          console.log(`✅ Sending PDF file: ${fileName}`);
          await sock.sendMessage(msg.key.remoteJid, {
            document: fs.readFileSync(filePath),
            mimetype: 'application/pdf',
            fileName: fileName,
            caption: `Here is the document you requested.`
          });
          await prisma.message.create({
            data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: `[Sent PDF: ${fileName}]`, isAiReply: true }
          });
        } else {
          console.log(`❌ FILE NOT FOUND! Listing actual files in folder:`);
          const dirPath = path.join(__dirname, '..', 'uploads', 'knowledge');
          if (fs.existsSync(dirPath)) {
             console.log(fs.readdirSync(dirPath));
          } else {
             console.log(`Directory ${dirPath} DOES NOT EXIST!`);
          }
          await sock.sendMessage(msg.key.remoteJid, { text: "I'm sorry, I couldn't find that specific file on the server. Please try uploading it again in the dashboard." });
        }
      } else {
        // Standard text reply
        await sock.sendMessage(msg.key.remoteJid, { text: aiReply });
        await prisma.message.create({
          data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiReply, isAiReply: true }
        });
      }


      // 🚨 CORRECTED: Only ONE declaration of finalSystemPrompt, including pdfRule at the end
      const finalSystemPrompt = timeContext + whatsappContext + basePrompt + contextRule + zoneRule + activePolicy + contactRule + pdfRule;

      console.log("🔍 DEBUG: Final System Prompt being sent to AI:\n", finalSystemPrompt);

      const recentMessages = await prisma.message.findMany({
        where: { 
          tenantId: tenant.id,
          OR: [ { fromNumber: fromNumber, toNumber: phoneNumber }, { fromNumber: phoneNumber, toNumber: fromNumber } ]
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

      // 🚨 CHECK IF AI WANTS TO SEND A PDF
      const pdfMatch = aiReply.match(/\[SEND_PDF:(.*?)\]/);
      
      if (pdfMatch) {
        const fileName = pdfMatch[1].trim();
        const filePath = path.join(__dirname, '..', 'uploads', 'knowledge', fileName);
        
        if (fs.existsSync(filePath)) {
          console.log(` Sending PDF file: ${fileName}`);
          await sock.sendMessage(msg.key.remoteJid, {
            document: fs.readFileSync(filePath),
            mimetype: 'application/pdf',
            fileName: fileName,
            caption: `Here is the document you requested: ${fileName}`
          });
          await prisma.message.create({
            data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: `[Sent PDF: ${fileName}]`, isAiReply: true }
          });
        } else {
          await sock.sendMessage(msg.key.remoteJid, { text: "I'm sorry, I couldn't find that file on the server." });
        }
      } else {
        // Standard text reply
        await sock.sendMessage(msg.key.remoteJid, { text: aiReply });
        await prisma.message.create({
          data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiReply, isAiReply: true }
        });
      }
    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets, qrCodes };