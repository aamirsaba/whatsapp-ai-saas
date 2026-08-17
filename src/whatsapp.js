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

      // 🚨 PER-USER CONVERSATION CONTROL
      let conversation = await prisma.conversation.findUnique({
        where: { 
          tenantId_userNumber: { tenantId: tenant.id, userNumber: fromNumber }
        },
        include: { assignedAgent: true }
      });

      // Auto-detect "talk to human" request
      const humanKeywords = ['/human', 'talk to human', 'speak to human', 'human agent', 'real person', 'talk to agent', 'tawk ila insan', 'تحدث الى انسان', 'تحدث إلى شخص', 'موظف', 'شخص حقيقي', 'agent', 'human'];
      const lowerText = text.toLowerCase();
      const wantsHuman = humanKeywords.some(kw => lowerText.includes(kw));

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

        // 🚨 NEW: Send Welcome & Handoff Message for new users using the custom AI name
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
        
        // NOTE: We do NOT return here. We let the code continue so the AI can also answer the user's first message!
      } else {
        // Update last message time
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date() }
        });
      }

      // 🚨 HANDLE "TALK TO AI" REQUEST (Switch back to AI)
      const aiKeywords = ['talk to ai', 'speak to ai', 'ai agent', 'robot', 'back to ai', 'تحدث الى الذكاء', 'العودة للذكاء', 'ai', 'bot', 'روبوت'];
      const wantsAI = aiKeywords.some(kw => lowerText.includes(kw));
      
      if (wantsAI && conversation.mode === 'HUMAN') {
        conversation = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { mode: 'AI', assignedAgentId: null },
          include: { assignedAgent: true }
        });
        
        const aiResumedMsg = `🤖 Great! I'm back to help you. How can I assist you today?`;
        await sock.sendMessage(msg.key.remoteJid, { text: aiResumedMsg });
        await prisma.message.create({
          data: { 
            tenantId: tenant.id, 
            fromNumber: phoneNumber, 
            toNumber: fromNumber, 
            direction: 'outbound', 
            content: aiResumedMsg, 
            isAiReply: true 
          }
        });
        console.log(`🤖 User ${fromNumber} switched back to AI mode`);
      }

      // 🚨 HANDLE "TALK TO HUMAN" REQUEST (Auto-assign agent + Send Alerts)
      if (wantsHuman && conversation.mode === 'AI') {
        const availableAgent = await prisma.agent.findFirst({
          where: { tenantId: tenant.id, isAvailable: true },
          orderBy: { createdAt: 'asc' }
        });

        if (availableAgent) {
          conversation = await prisma.conversation.update({
            where: { id: conversation.id },
            data: { 
              mode: 'HUMAN', 
              assignedAgentId: availableAgent.id 
            },
            include: { assignedAgent: true }
          });
          
          // 1. Send handoff message to the CUSTOMER
          const handoffMsg = `👨‍💼 Perfect! I'm connecting you with our specialist *${availableAgent.name}* now. They speak ${JSON.parse(availableAgent.languages).join(', ')} and will reply shortly!\n\n(Your chat is now with a human. Say "talk to AI" anytime to switch back.)`;
          
          await sock.sendMessage(msg.key.remoteJid, { text: handoffMsg });
          await prisma.message.create({
            data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: handoffMsg, isAiReply: true }
          });

          // 2. 🚨 NEW: Send INSTANT ALERT to the AGENT via WhatsApp
          if (availableAgent.whatsappNumber) {
            const agentJid = availableAgent.whatsappNumber.replace(/\D/g, '') + '@s.whatsapp.net';
            const alertMsg = `🚨 *URGENT: Human Handoff Required!*\n\n👤 *Customer:* +${fromNumber}\n💬 *Customer just said:* "${text}"\n\n🔗 Please log in to your Agent Dashboard immediately to reply.`;
            
            try {
              await sock.sendMessage(agentJid, { text: alertMsg });
              console.log(`✅ Alert sent to agent ${availableAgent.name} at ${availableAgent.whatsappNumber}`);
            } catch (err) {
              console.error(`❌ Failed to send WhatsApp alert to agent:`, err);
            }
          }

          // 3. 🚨 NEW: Send Email Alert to Agent (if email exists)
          if (availableAgent.email) {
            try {
              // Assuming you have an email utility, or we can add a simple nodemailer call here
              console.log(`📧 Email alert queued for agent ${availableAgent.email} regarding customer +${fromNumber}`);
              // TODO: Add nodemailer.sendMail({ to: availableAgent.email, subject: 'Urgent: Customer Handoff', text: alertMsg })
            } catch (err) {
              console.error(`❌ Failed to send email alert to agent:`, err);
 }
          }

          console.log(`🔄 Auto-handoff: ${fromNumber} → Agent ${availableAgent.name}`);
          return; // Stop here, don't call AI
        } else {
          // No agents available
          const noAgentMsg = `👨‍💼 I understand you'd like to speak with a human. Unfortunately, all our agents are currently busy. Please try again in a few minutes, or say "talk to AI" and I'll be happy to help you!`;
          await sock.sendMessage(msg.key.remoteJid, { text: noAgentMsg });
          await prisma.message.create({ data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: noAgentMsg, isAiReply: true } });
          console.log(`⚠️ Auto-handoff failed: No available agents for ${fromNumber}`);
          return;
        }
      }

      // 🚨 CHECK: If mode is HUMAN, save message and STOP (don't call AI)
      if (conversation.mode === 'HUMAN') {
        console.log(`👨‍💻 HUMAN MODE: Message from ${fromNumber} saved. Agent: ${conversation.assignedAgent?.name || 'Unassigned'}`);
        return; // Exit early - AI does NOT reply
      }

      // ==========================================
      // CONTINUE WITH NORMAL AI FLOW BELOW
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

      const uploadedDocs = await prisma.knowledgeDocument.findMany({ 
        where: { tenantId: tenant.id },
        select: { fileName: true }
      });
      const pdfFileList = uploadedDocs.map(doc => doc.fileName).join(', ');
      
      const pdfRule = pdfFileList 
        ? `\n\n📄 AVAILABLE PDF FILES ON SERVER: [${pdfFileList}]. \n🚨 CRITICAL RULE: You may ONLY output the exact string "[SEND_PDF:filename.pdf]" if BOTH conditions are met: 1) The user explicitly asks to "send pdf" or "share the pdf file". 2) The filename you output MUST EXACTLY match one of the files in the AVAILABLE PDF FILES list above. NEVER invent, guess, or hallucinate filenames. If the user asks for a document not in the list, reply in plain text: "I'm sorry, I don't have that specific document uploaded yet, but I can provide the details in text."` 
        : '';

      // 🚨 1. BUILD PROMPT FIRST
      const finalSystemPrompt = timeContext + whatsappContext + basePrompt + contextRule + zoneRule + activePolicy + contactRule + pdfRule;

      // 🚨 2. GET CHAT HISTORY SECOND
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

      // 🚨 3. GET AI REPLY THIRD (ONLY DECLARED ONCE!)
      const aiReply = await getAIResponse(chatHistory, finalSystemPrompt, tenant);
      console.log(`🗣️ AI Reply: ${aiReply}`);

      // 🚨 Bulletproof Regex: Catches [SEND_PDF:file.pdf], [Sent PDF: file.pdf], [send pdf: file.pdf], etc.
      const pdfMatch = aiReply.match(/\[(?:send|sent)[_ ]?pdf[:\s]+(.*?\.pdf)\]/i);
      
      if (pdfMatch) {
        const fileName = pdfMatch[1].trim();
        const filePath = path.join(__dirname, '..', 'uploads', 'knowledge', fileName);
        
        console.log(`\n🔍 ========== PDF DEBUG START ==========`);
        console.log(`🔍 AI requested fileName: "${fileName}"`);
        console.log(`🔍 Full path: "${filePath}"`);
        console.log(`🔍 File exists? ${fs.existsSync(filePath)}`);
        
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          console.log(`🔍 File size: ${stats.size} bytes`);
          
          if (stats.size === 0) {
            console.log(`❌ FILE IS EMPTY (0 bytes)! Cannot send.`);
            await sock.sendMessage(msg.key.remoteJid, { text: "I found the file, but it appears to be empty. Please re-upload it in the dashboard." });
          } else {
            try {
              console.log(`✅ Attempting to send PDF file: ${fileName}`);
              const fileBuffer = fs.readFileSync(filePath);
              console.log(`🔍 Buffer size: ${fileBuffer.length} bytes`);
              
              await sock.sendMessage(msg.key.remoteJid, {
                document: fileBuffer,
                mimetype: 'application/pdf',
                fileName: fileName,
                caption: `Here is the document you requested: ${fileName}`
              });
              
              console.log(`✅ PDF sent successfully!`);
              await prisma.message.create({
                data: { tenantId: tenant.id, fromNumber: phoneNumber, toNumber: fromNumber, direction: 'outbound', content: `[Sent PDF: ${fileName}]`, isAiReply: true }
              });
            } catch (sendError) {
              console.error(`❌ ERROR SENDING PDF:`, sendError);
              await sock.sendMessage(msg.key.remoteJid, { text: `I tried to send the file but encountered an error: ${sendError.message}` });
            }
          }
        } else {
          console.log(`❌ FILE NOT FOUND! AI hallucinated filename: "${fileName}". Actual files in folder:`, fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : 'DIR NOT FOUND');
          
          // Send a natural, helpful message instead of a raw server error
          await sock.sendMessage(msg.key.remoteJid, { 
            text: "I apologize, it seems I tried to reference a file that isn't uploaded to my system yet. Could you please specify which document you need, or I can provide the details in text?" 
          });
        }
        console.log(`🔍 ========== PDF DEBUG END ==========\n`);
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