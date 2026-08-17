const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcodeTerminal = require('qrcode-terminal');
const { toDataURL } = require('qrcode');
const pino = require('pino');
const { PrismaClient } = require('@prisma/client');
const { getAIResponse } = require('./ai');
const { getPolicyForTenant } = require('./policies');
const fs = require('fs');
const path = require('path');

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

      // ==========================================
      // 1. PER-USER CONVERSATION CONTROL & WELCOME
      // ==========================================
      let conversation = await prisma.conversation.findUnique({
        where: { 
          tenantId_userNumber: { tenantId: tenant.id, userNumber: fromNumber }
        },
        include: { assignedAgent: true }
      });

      const humanKeywords = ['/human', 'talk to human', 'speak to human', 'human agent', 'real person', 'talk to agent', 'tawk ila insan', 'تحدث الى انسان', 'تحدث إلى شخص', 'موظف', 'شخص حقيقي', 'agent', 'human'];
      const aiKeywords = ['talk to ai', 'speak to ai', 'ai agent', 'robot', 'back to ai', 'تحدث الى الذكاء', 'العودة للذكاء', 'ai', 'bot', 'روبوت'];
      const lowerText = text.toLowerCase();
      const wantsHuman = humanKeywords.some(kw => lowerText.includes(kw));
      const wantsAI = aiKeywords.some(kw => lowerText.includes(kw));

      if (!conversation) {
        // Create new conversation (default: AI mode)
        conversation = await prisma.conversation.create({
          data: {
            tenantId: tenant.id,
            userNumber: fromNumber,
            mode: 'AI',
            lastMessageAt: new Date()
          }
        });
        console.log(`💬 New conversation created for ${fromNumber} (AI Mode)`);

        // 🚨 Send Welcome Message for new users ONLY
        const agentName = tenant.aiAgentName || 'AI Assistant';
        const welcomeMsg = `Hi there! 👋 I'm *${agentName}*, your personal assistant. I'm here to help you 24/7!\n\n💡 *Need a human?* Anytime you want to speak with a real person, just type */human* or *talk to human*, and I'll connect you right away.\n\nHow can I help you today?`;

        await sock.sendMessage(msg.key.remoteJid, { text: welcomeMsg });
        await prisma.message.create({
          data: { 
            tenantId: tenant.id, 
            fromNumber: phoneNumber, 
            toNumber: fromNumber, 
            direction: 'outbound', 
            content: welcomeMsg, 
            isAiReply: true 
          }
        });
        
        // 🚨 CRITICAL FIX: STOP HERE. Do not generate a second AI response for the first message.
        return; 
      }

      // Update last message time for existing conversations
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() }
      });

      // ==========================================
      // 2. HANDLE "TALK TO AI" REQUEST
      // ==========================================
      if (wantsAI && conversation.mode === 'HUMAN') {
        conversation = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { mode: 'AI', assignedAgentId: null },
          include: { assignedAgent: true }
        });
        
        const aiResumedMsg = `🤖 Great! I'm back to help you. How can I assist you today?`;
        await sock.sendMessage(msg.key.remoteJid, { text: aiResumedMsg });
        await prisma.message.create({
          data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiResumedMsg, isAiReply: true }
        });
        console.log(`🤖 User ${fromNumber} switched back to AI mode`);
      }

      // ==========================================
      // 3. HANDLE "TALK TO HUMAN" REQUEST
      // ==========================================
      if (wantsHuman && conversation.mode === 'AI') {
        const availableAgent = await prisma.agent.findFirst({
          where: { tenantId: tenant.id, isAvailable: true },
          orderBy: { createdAt: 'asc' }
        });

        if (availableAgent) {
          conversation = await prisma.conversation.update({
            where: { id: conversation.id },
            data: { mode: 'HUMAN', assignedAgentId: availableAgent.id },
            include: { assignedAgent: true }
          });
          
          const handoffMsg = `👨‍💼 Perfect! I'm connecting you with our specialist *${availableAgent.name}* now. They speak ${JSON.parse(availableAgent.languages).join(', ')} and will reply shortly!\n\n(Your chat is now with a human. Say "talk to AI" anytime to switch back.)`;
          
          await sock.sendMessage(msg.key.remoteJid, { text: handoffMsg });
          await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: handoffMsg, isAiReply: true } });

          // Send INSTANT ALERT to the AGENT via WhatsApp
          if (availableAgent.whatsappNumber) {
            const agentJid = availableAgent.whatsappNumber.replace(/\D/g, '') + '@s.whatsapp.net';
            const alertMsg = `🚨 *URGENT: Human Handoff Required!*\n\n👤 *Customer:* +${fromNumber}\n💬 *Customer just said:* "${text}"\n\n🔗 *Login to reply:* https://bot.aamirsaba.com/login\n\nPlease log in to your Agent Dashboard immediately to assist this customer.`;            
            try {
              await sock.sendMessage(agentJid, { text: alertMsg });
              console.log(`✅ Alert sent to agent ${availableAgent.name} at ${availableAgent.whatsappNumber}`);
            } catch (err) {
              console.error(`❌ Failed to send WhatsApp alert to agent:`, err);
            }
          }

          console.log(`🔄 Auto-handoff: ${fromNumber} → Agent ${availableAgent.name}`);
          return; // Stop here, don't call AI
        } else {
          const noAgentMsg = `👨‍💼 I understand you'd like to speak with a human. Unfortunately, all our agents are currently busy. Please try again in a few minutes, or say "talk to AI" and I'll be happy to help you!`;
          await sock.sendMessage(msg.key.remoteJid, { text: noAgentMsg });
          await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: noAgentMsg, isAiReply: true } });
          return;
        }
      }

      // ==========================================
      // 4. CHECK IF MODE IS HUMAN (Stop AI)
      // ==========================================
      if (conversation.mode === 'HUMAN') {
        console.log(`👨‍💻 HUMAN MODE: Message from ${fromNumber} saved. Agent: ${conversation.assignedAgent?.name || 'Unassigned'}`);
        return; // Exit early - AI does NOT reply
      }

      // ==========================================
      // 5. SAVE INBOUND MESSAGE & LEAD
      // ==========================================
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
        console.log(` Human Mode Active: AI paused globally. Message from ${fromNumber} saved for manual reply.`);
        return;
      }

      // ==========================================
      // 6. GENERATE AI RESPONSE WITH ULTRA-STRICT RULES
      // ==========================================
      const agentName = tenant.aiAgentName || 'AI Assistant';
      
      const identityRule = `\n\n🤖 YOUR IDENTITY: You are *${agentName}*, the official AI assistant for ${tenant.businessName || 'this business'}. You MUST introduce yourself as ${agentName}. NEVER use generic titles.`;
      const knowledgeRule = `\n\n📚 KNOWLEDGE BOUNDARY: ONLY discuss courses, services, and information that are explicitly provided in your BUSINESS CONTEXT or KNOWLEDGE BASE below. DO NOT invent, hallucinate, or add courses, dates, prices, or details that are not in your provided context.`;
      
      const uploadedDocs = await prisma.knowledgeDocument.findMany({ 
        where: { tenantId: tenant.id },
        select: { fileName: true }
      });
      const pdfFileList = uploadedDocs.map(doc => doc.fileName).join(', ');
      
      const strictPdfRule = pdfFileList 
        ? `\n\n📄 AVAILABLE PDF FILES: [${pdfFileList}]. \n🚨 CRITICAL PDF RULE: You are FORBIDDEN from outputting "[SEND_PDF:..." or mentioning sending a PDF unless the user EXPLICITLY asks you to "send the pdf", "share the file", or "give me the document". If the user asks about courses or info, provide the answer in plain text ONLY. NEVER proactively offer to send a PDF.` 
        : '';

      const basePrompt = (tenant.systemPrompt || "You are a helpful, professional AI assistant.") + identityRule + knowledgeRule + strictPdfRule;
      const finalSystemPrompt = basePrompt + (tenant.businessContext ? `\n\nBUSINESS CONTEXT:\n${tenant.businessContext}` : '') + (tenant.contactInfo ? `\n\nCONTACT INFO:\n${tenant.contactInfo}` : '');

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

      // ==========================================
      // 7. HANDLE AI REPLY & PDF SENDING (SEND ONLY ONCE)
      // ==========================================
      const pdfMatch = aiReply.match(/\[(?:send|sent)[_ ]?pdf[:\s]+(.*?\.pdf)\]/i);
      const disclaimer = "\n\n---\n*AI-generated content may not be accurate.*";
      
      if (pdfMatch) {
        const fileName = pdfMatch[1].trim();
        const filePath = path.join(__dirname, '..', 'uploads', 'knowledge', fileName);
        const dirPath = path.join(__dirname, '..', 'uploads', 'knowledge'); // 🚨 FIX: Define dirPath
        
        console.log(`\n🔍 ========== PDF DEBUG START ==========`);
        console.log(`🔍 AI requested fileName: "${fileName}"`);
        console.log(`🔍 Full path: "${filePath}"`);
        console.log(`🔍 File exists? ${fs.existsSync(filePath)}`);
        
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          if (stats.size === 0) {
            const errorMsg = "I found the file, but it appears to be empty. Please re-upload it in the dashboard.";
            await sock.sendMessage(msg.key.remoteJid, { text: errorMsg + disclaimer });
            await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: errorMsg, isAiReply: true } });
          } else {
            try {
              const fileBuffer = fs.readFileSync(filePath);
              await sock.sendMessage(msg.key.remoteJid, {
                document: fileBuffer,
                mimetype: 'application/pdf',
                fileName: fileName,
                caption: `Here is the document you requested: ${fileName}${disclaimer}`
              });
              await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: `[Sent PDF: ${fileName}]`, isAiReply: true } });
              console.log(`✅ PDF sent successfully!`);
            } catch (sendError) {
              console.error(`❌ ERROR SENDING PDF:`, sendError);
              const errorMsg = `I tried to send the file but encountered an error.`;
              await sock.sendMessage(msg.key.remoteJid, { text: errorMsg + disclaimer });
              await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: errorMsg, isAiReply: true } });
            }
          }
        } else {
          console.log(`❌ FILE NOT FOUND! AI hallucinated filename: "${fileName}". Actual files:`, fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : 'DIR NOT FOUND');
          const fallbackMsg = "I apologize, it seems I tried to reference a file that isn't uploaded to my system yet. Could you please specify which document you need, or I can provide the details in text?";
          await sock.sendMessage(msg.key.remoteJid, { text: fallbackMsg + disclaimer });
          await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: fallbackMsg, isAiReply: true } });
        }
        console.log(`🔍 ========== PDF DEBUG END ==========\n`);
      } else {
        // Standard text reply (ONLY SEND ONCE)
        const aiReplyWithDisclaimer = aiReply + disclaimer;
        await sock.sendMessage(msg.key.remoteJid, { text: aiReplyWithDisclaimer });
        await prisma.message.create({
          data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: aiReplyWithDisclaimer, isAiReply: true }
        });
      }

    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
}

module.exports = { startWhatsAppSession, activeSockets, qrCodes };