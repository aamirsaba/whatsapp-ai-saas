const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { PrismaClient } = require('@prisma/client');
const { getAIResponse } = require('./ai');
const path = require('path');
const fs = require('fs');

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

  let isMismatch = false; // 🚨 Track mismatch to prevent reconnect loops

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    
    if (sock.authState?.creds?.me?.id) {
      const scannedNumber = sock.authState.creds.me.id.split(':')[0];
      
      if (scannedNumber !== phoneNumber) {
        console.error(`🚨 SECURITY ALERT: Mismatch detected! Expected ${phoneNumber}, but ${scannedNumber} scanned the QR.`);
        isMismatch = true;
        sock.logout(); 
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`\n📱 SCAN THIS QR CODE WITH WHATSAPP FOR: ${phoneNumber}`);
      qrcode.generate(qr, { small: true });
      if (onQrGenerated) onQrGenerated(phoneNumber, qr);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
      
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isForbidden = statusCode === DisconnectReason.forbidden; 
      
      console.log('⚠️ Connection closed. Status:', statusCode, 'Reconnecting:', !isLoggedOut && !isForbidden && !isMismatch);
      
      // 🛑 STOP LOOPING: Do not reconnect if logged out, forbidden, mismatch, or undefined status
      if (!isLoggedOut && !isForbidden && !isMismatch && statusCode !== undefined) {
        startWhatsAppSession(tenantId, phoneNumber, onQrGenerated, onConnected);
      } else {
        console.log('🛑 Session terminated permanently. Cleaning up corrupted data...');
        
        // 🗑️ Clean up the corrupted auth folder so a fresh QR can be generated next time
        const authDir = path.join(process.cwd(), `auth_info_${phoneNumber}`);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('✅ Corrupted auth folder deleted.');
        }
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

    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets };