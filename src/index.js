
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { startWhatsAppSession, activeSockets, qrCodes } = require('./whatsapp');
const { registerUser, loginUser } = require('./auth');
const { authenticateToken } = require('./middleware'); // 🚀 NEW: Auth Middleware
const { getAIResponse, translateText } = require('./ai'); // 🚨 ADDED translateText


const axios = require('axios');
const cheerio = require('cheerio');

const cron = require('node-cron');

const multer = require('multer');
const Tesseract = require('tesseract.js');
const { fromPath } = require('pdf2pic'); // 🚨 CORRECT IMPORT (not 'convert')

const knowledgeStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/knowledge/');
  },
  filename: function (req, file, cb) {
    // Save with the exact original name (e.g., "Power BI Course.pdf")
    cb(null, file.originalname);
  }
});

const knowledgeUpload = multer({ 
  storage: knowledgeStorage,
  limits: { fileSize: 50 * 1024 * 1024 } // 🚨 INCREASED TO 50MB (was 10MB)
});

// Ensure the folder exists on startup
if (!require('fs').existsSync('uploads/knowledge')) {
  require('fs').mkdirSync('uploads/knowledge', { recursive: true });
}
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');

// Configure Multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const app = express();

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const prisma = new PrismaClient();
app.use(express.json());

// ==========================================
// 🚨 SUPER ADMIN MIDDLEWARE (MUST BE BEFORE ROUTES)
// ==========================================
const authenticateSuperAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    // Verify token (make sure your JWT_SECRET matches your .env)
    const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this');
    
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    
    // Check if user exists and is an ADMIN
    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// 🚨 CRITICAL: Serve static files (HTML, CSS, JS) from the 'public' folder
// This fixes the "Cannot GET /accept-invitation.html" error

app.use(express.static(path.join(__dirname, '..', 'public')));

// 🧠 CACHE TO REMEMBER THE LATEST QR CODE FOR EACH NUMBER
const qrCache = {};

// ==========================================
// 🚀 AUTH ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, businessName, whatsappNumber, businessContext, inviteToken } = req.body;
    
    // 🚨 NEW: Check if this is an invitation registration
    if (inviteToken) {
      // Verify the invitation token matches the email
      // For now, we'll just trust the token and auto-add them
      console.log(`🎉 Processing invitation registration for ${email}`);
    }
    
    // 🚨 Password is now OPTIONAL. Backend will auto-generate if missing.
    if (!email || !businessName || !whatsappNumber || !businessContext) {
      return res.status(400).json({ error: 'Email, business name, WhatsApp number, and Business Context are all required.' });
    }
    
    const cleanNumber = whatsappNumber.replace(/\D/g, '');
    const result = await registerUser(email, password, businessName, cleanNumber, businessContext);
    
    // 🚨 NEW: If they registered via invitation, auto-add them as team member
    if (inviteToken && result.tenant) {
      try {
        // Find the tenant who sent the invitation
        // This requires knowing which tenant invited them
        // For MVP, we'll skip this and just log it
        console.log(`✅ User ${email} registered via invitation. Auto-adding as team member (TODO: implement auto-add logic)`);
      } catch (teamError) {
        console.error('Failed to auto-add as team member:', teamError);
      }
    }
    
    startWhatsAppSession(result.tenant.id, cleanNumber, handleQr, handleSuccess);

    res.status(201).json({ success: true, message: 'Account created! Check your email for your auto-generated password.', ...result });
  } catch (error) {
    console.error('❌ Registration Error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});



// ==========================================
//  SUPER ADMIN: GET ALL TENANTS
// ==========================================
app.get('/api/admin/tenants', authenticateSuperAdmin, async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, tenants });
  } catch (error) {
    console.error('Get tenants error:', error);
    res.status(500).json({ error: 'Failed to load tenants.' });
  }
});

// ==========================================
// 🚨 SUPER ADMIN: ADD TOKENS (TOP-UP)
// ==========================================
app.post('/api/admin/tenants/:id/add-tokens', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body; // Amount of tokens to add

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid token amount.' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Add tokens to their wallet
    const updatedTenant = await prisma.tenant.update({
      where: { id },
      data: { 
        tokenBalance: { increment: amount },
        isSuspended: false // Auto-unsuspend if they pay
      }
    });

// After successfully adding tokens:
await prisma.alert.create({
  data: {
    type: 'success',
    title: 'Tokens Added',
    message: `Added ${amount.toLocaleString()} tokens to ${tenant.businessName}. New balance: ${updatedTenant.tokenBalance.toLocaleString()}`,
    tenantId: id
  }
});
    console.log(`✅ Added ${amount} tokens to ${tenant.businessName}. New balance: ${updatedTenant.tokenBalance}`);
    res.json({ success: true, tenant: updatedTenant });
  } catch (error) {
    console.error('Add tokens error:', error);
    res.status(500).json({ error: 'Failed to add tokens.' });
  }
});

// ==========================================
// 🚨 SUPER ADMIN: SUSPEND / ACTIVATE TENANT
// ==========================================
app.patch('/api/admin/tenants/:id/status', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isSuspended } = req.body;

    await prisma.tenant.update({
      where: { id },
      data: { isSuspended }
    });

    res.json({ success: true, message: `Tenant ${isSuspended ? 'suspended' : 'activated'}.` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status.' });
  }
});


// ==========================================
// 🚨 ALERTS: GET ALL ALERTS (Super Admin)
// ==========================================
app.get('/api/admin/alerts', authenticateSuperAdmin, async (req, res) => {
  try {
    const { limit = 50, unreadOnly = false } = req.query;
    
    const where = {};
    if (unreadOnly === 'true') {
      where.isRead = false;
    }

    const alerts = await prisma.alert.findMany({
      where,
      include: { tenant: { select: { businessName: true } } },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit)
    });

    const unreadCount = await prisma.alert.count({ where: { isRead: false } });

    res.json({ success: true, alerts, unreadCount });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Failed to load alerts.' });
  }
});

// ==========================================
// 🚨 ALERTS: MARK AS READ
// ==========================================
app.patch('/api/admin/alerts/:id/read', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    await prisma.alert.update({
      where: { id },
      data: { isRead: true }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark as read.' });
  }
});

// ==========================================
// 🚨 ALERTS: MARK ALL AS READ
// ==========================================
app.patch('/api/admin/alerts/read-all', authenticateSuperAdmin, async (req, res) => {
  try {
    await prisma.alert.updateMany({
      where: {},
      data: { isRead: true }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark all as read.' });
  }
});

// ==========================================
//  ALERTS: CREATE ALERT (Internal use)
// ==========================================
app.post('/api/admin/alerts', authenticateSuperAdmin, async (req, res) => {
  try {
    const { type, title, message, tenantId } = req.body;

    const alert = await prisma.alert.create({
      data: { type, title, message, tenantId }
    });

    res.json({ success: true, alert });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create alert.' });
  }
});

// ==========================================
// 🚨 HELPER: AUTO-CREATE ALERTS
// ==========================================

// Example: Create alert when tenant is low on tokens
async function checkLowTokenBalance(tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  
  if (tenant && tenant.tokenBalance < 10000) { // Less than 10k tokens
    await prisma.alert.create({
      data: {
        type: 'warning',
        title: 'Low Token Balance',
        message: `${tenant.businessName} has only ${tenant.tokenBalance.toLocaleString()} tokens remaining.`,
        tenantId
      }
    });
  }
}

// Example: Create alert when new tenant signs up
async function notifyNewTenant(tenantId) {
  const tenant = await prisma.tenant.findUnique({ 
    where: { id: tenantId },
    include: { user: true }
  });
  
  if (tenant) {
    await prisma.alert.create({
      data: {
        type: 'success',
        title: 'New Client Registered',
        message: `${tenant.businessName} (${tenant.user.email}) just signed up for the ${tenant.plan} plan.`,
        tenantId
      }
    });
  }
}

// ==========================================
// 🔐 UPDATE PASSWORD (Force change after first login)
// ==========================================
app.post('/api/auth/update-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    // Get user
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Verify current password
    const bcrypt = require('bcryptjs');
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        requiresPasswordChange: false // Mark as changed
      }
    });

    // Generate new JWT token
    const jwt = require('jsonwebtoken');
    const newToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      { expiresIn: '7d' }
    );

    console.log(`✅ Password updated for user: ${user.email}`);

    res.json({
      success: true,
      message: 'Password updated successfully.',
      token: newToken,
      user: {
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('❌ Update password error:', error);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// 🚀 5-MINUTE MVP WIZARD REGISTRATION (AUTO-GENERATE PASSWORD)
app.post('/api/register-wizard', async (req, res) => {
  try {
    const { email, businessName, industry, websiteUrl, whatsappNumber, botType, llmApiKey } = req.body;

    // 1. Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: 'Email already in use.' });

    // 2. 🚨 AUTO-GENERATE SECURE 12-CHARACTER PASSWORD
    const crypto = require('crypto');
    const autoPassword = crypto.randomBytes(6).toString('hex');
    const hashedPassword = await require('bcryptjs').hash(autoPassword, 10);
    
    // 🚨 ADDED: requiresPasswordChange: true to force the update flow
const newUser = await prisma.user.create({
  data: { 
    email, 
    password: hashedPassword, 
    role: 'TENANT',
    requiresPasswordChange: true // 🚨 THIS MUST BE HERE
  }
});

    // 3. Auto-generate Context based on Industry
    let autoContext = `This business operates in the ${industry} industry.`;
    if (websiteUrl) autoContext += ` Their website is ${websiteUrl}. Use this context to answer questions accurately.`;
    
    // 4. 🚨 SMART INDUSTRY-TO-PROMPT MAPPING
    let autoPrompt = "You are a helpful, professional AI assistant for this business. Be concise, polite, and accurate.";
    
    // 🚨 DECLARE 'ind' ONLY ONCE HERE:
    const ind = industry.toLowerCase();
    
    // 🎭 PERSONAL BOT CATEGORIES
    if (ind.includes('emotional')) {
      autoPrompt = "You are a compassionate, empathetic emotional support companion. Listen actively, validate feelings, offer coping strategies. Never diagnose. Encourage professional help for serious issues.";
    }
    else if (ind.includes('islamic') || ind.includes('scholar')) {
      autoPrompt = "You are a knowledgeable Islamic scholar assistant. Answer questions based on Quran and authentic Sunnah. Provide Arabic references. Be respectful and compassionate.";
    }
    else if (ind.includes('depression') || ind.includes('relief')) {
      autoPrompt = "You are a supportive mental health companion. Use gentle encouragement, track mood patterns, and suggest healthy coping mechanisms. Always include a gentle reminder to seek professional help if in crisis.";
    }
    else if (ind.includes('storytelling')) {
      autoPrompt = "You are a master storyteller. Create engaging narratives with vivid descriptions, strong characters, and compelling plots. Adapt to the user's preferred genre.";
    }
    else if (ind.includes('content creation')) {
      autoPrompt = "You are a viral content strategist. Help create YouTube scripts, social media posts, and blog ideas. Focus on hooks, retention, and audience engagement.";
    }
    else if (ind.includes('cooking')) {
      autoPrompt = "You are a professional chef assistant. Provide recipes, cooking techniques, meal planning, and dietary substitutions. Be encouraging, practical, and safety-conscious.";
    }
    else if (ind.includes('faith') || ind.includes('spirituality')) {
      autoPrompt = "You are a supportive faith and spirituality guide. Offer encouragement, positive affirmations, and spiritual wisdom. Be respectful and uplifting.";
    }
    else if (ind.includes('personal development')) {
      autoPrompt = "You are a personal development coach. Help set goals, track progress, build habits, and stay motivated. Be encouraging, practical, and action-oriented.";
    }
    // 🏠 BUSINESS BOT CATEGORIES
    else if (ind.includes('real estate') || ind.includes('property')) {
      autoPrompt = "You are a top-tier Real Estate AI Sales Agent. Your goal is to qualify buyers/renters, answer property questions, showcase listings, and proactively book property viewings. Always ask about their budget and preferred location.";
    }
    else if (ind.includes('automotive') || ind.includes('dealership')) {
      autoPrompt = "You are a professional Automotive Dealership AI Assistant. Help customers with vehicle inquiries, test drive bookings, financing questions, and service appointments. Be knowledgeable and persuasive.";
    }
    else if (ind.includes('e-commerce') || ind.includes('online store') || ind.includes('retail')) {
      autoPrompt = "You are an E-commerce AI Sales Assistant. Help customers with product questions, order status, shipping info, returns, and drive conversions. Be friendly and solution-oriented.";
    }
    else if (ind.includes('restaurant') || ind.includes('cafe') || ind.includes('food')) {
      autoPrompt = "You are a Restaurant AI Host. Help customers with menu questions, dietary restrictions, table reservations, delivery options, and operating hours. Be warm and welcoming.";
    }
    else if (ind.includes('hotel') || ind.includes('resort') || ind.includes('hospitality')) {
      autoPrompt = "You are a Hotel & Hospitality AI Concierge. Assist with room bookings, amenities, check-in/out times, local attractions, and special requests. Be elegant and service-oriented.";
    }
    else if (ind.includes('travel') || ind.includes('tourism') || ind.includes('ticketing')) {
      autoPrompt = "You are a Travel & Tourism AI Agent. Help with bookings, itineraries, visa info, package details, and travel recommendations. Be enthusiastic and detail-oriented.";
    }
    else if (ind.includes('event')) {
      autoPrompt = "You are an Event Planning AI Coordinator. Help clients with venue options, packages, catering, guest management, and booking consultations. Be organized and creative.";
    }
    else if (ind.includes('medical') || ind.includes('clinic') || ind.includes('healthcare') || ind.includes('hospital')) {
      autoPrompt = "You are a professional Medical Clinic AI Receptionist. Answer patient questions, provide clinic hours, help with appointment booking, and handle general inquiries. ⚠️ CRITICAL: Never provide medical diagnoses. Always advise consulting a doctor for health concerns.";
    }
    else if (ind.includes('beauty') || ind.includes('salon') || ind.includes('spa')) {
      autoPrompt = "You are a Beauty Salon & Spa AI Assistant. Help clients with service menus, pricing, stylist availability, and appointment bookings. Be friendly and make them feel pampered.";
    }
    else if (ind.includes('fitness') || ind.includes('gym') || ind.includes('training')) {
      autoPrompt = "You are a Fitness & Gym AI Assistant. Help with membership plans, class schedules, trainer bookings, and facility info. Be motivating and energetic.";
    }
    else if (ind.includes('mental health') || ind.includes('counseling')) {
      autoPrompt = "You are a Mental Health & Counseling AI Assistant. Help with appointment booking, service info, and general inquiries. Be empathetic and supportive. ⚠️ CRITICAL: Never provide medical advice. In crisis situations, always direct to emergency services.";
    }
    else if (ind.includes('vet') || ind.includes('pet')) {
      autoPrompt = "You are a Veterinary Clinic AI Assistant. Help pet owners with appointment booking, service info, and general pet care questions. Be caring and knowledgeable. ⚠️ Never provide emergency medical advice - direct to the vet immediately for urgent issues.";
    }
    else if (ind.includes('field service') || ind.includes('home maintenance') || ind.includes('plumbing') || ind.includes('ac') || ind.includes('electrical')) {
      autoPrompt = "You are a Field Service AI Dispatcher. Confirm service areas, answer pricing questions, book technician visits, and handle emergency requests. Be efficient and reassuring.";
    }
    else if (ind.includes('cleaning')) {
      autoPrompt = "You are a Cleaning Services AI Coordinator. Help clients with service types (residential/commercial), pricing, scheduling, and special requests. Be thorough and trustworthy.";
    }
    else if (ind.includes('construction') || ind.includes('architecture') || ind.includes('contracting')) {
      autoPrompt = "You are a Construction & Contracting AI Assistant. Help with project inquiries, quotes, service areas, and consultation bookings. Be professional and detail-oriented.";
    }
    else if (ind.includes('logistics') || ind.includes('delivery') || ind.includes('courier')) {
      autoPrompt = "You are a Logistics & Delivery AI Assistant. Help with shipping quotes, tracking, service areas, and booking pickups. Be fast and accurate.";
    }
    else if (ind.includes('legal') || ind.includes('law')) {
      autoPrompt = "You are a Law Firm AI Assistant. Help with practice areas, attorney info, consultation bookings, and general inquiries. Be professional and discreet. ⚠️ Never provide specific legal advice - always direct to an attorney.";
    }
    else if (ind.includes('financial') || ind.includes('accounting') || ind.includes('tax') || ind.includes('wealth')) {
      autoPrompt = "You are a Financial Services AI Assistant. Help with service info, appointment bookings, and general inquiries. Be professional and trustworthy. ⚠️ Never provide specific financial or investment advice.";
    }
    else if (ind.includes('marketing') || ind.includes('advertising') || ind.includes('agency')) {
      autoPrompt = "You are a Marketing Agency AI Assistant. Help potential clients with service offerings, case studies, pricing, and consultation bookings. Be creative and results-focused.";
    }
    else if (ind.includes('it') || ind.includes('software') || ind.includes('saas')) {
      autoPrompt = "You are an IT & Software Solutions AI Assistant. Help with product demos, pricing, technical questions, and sales inquiries. Be knowledgeable and solution-oriented.";
    }
    else if (ind.includes('hr') || ind.includes('recruitment') || ind.includes('staffing')) {
      autoPrompt = "You are an HR & Recruitment AI Assistant. Help with service info, candidate inquiries, client bookings, and general questions. Be professional and people-focused.";
    }
    else if (ind.includes('school') || ind.includes('university') || ind.includes('academy')) {
      autoPrompt = "You are an Educational Institution AI Assistant. Help with admissions, programs, fees, campus info, and enrollment. Be informative and welcoming.";
    }
    else if (ind.includes('online course') || ind.includes('tutoring')) {
      autoPrompt = "You are an Online Education AI Assistant. Help with course info, enrollment, pricing, and instructor details. Be encouraging and helpful.";
    }
    else if (ind.includes('coaching') || ind.includes('consulting')) {
      autoPrompt = "You are a Coaching & Consulting AI Assistant. Help potential clients understand your services, book discovery calls, and answer FAQs. Be inspiring and professional.";
    }
    else if (ind.includes('media') || ind.includes('publishing') || ind.includes('content')) {
      autoPrompt = "You are a Media & Content Creation AI Assistant. Help with service inquiries, portfolio info, collaboration requests, and bookings. Be creative and engaging.";
    }
    else if (ind.includes('non-profit') || ind.includes('community')) {
      autoPrompt = "You are a Non-Profit Organization AI Assistant. Help with mission info, volunteering, donations, and events. Be warm and mission-driven.";
    }
    else if (ind.includes('government') || ind.includes('public service')) {
      autoPrompt = "You are a Government & Public Service AI Assistant. Help citizens with service info, office hours, required documents, and procedures. Be clear and respectful.";
    }

    // 5. Create Tenant with DEFAULT QWEN API KEY for trials
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 2); // 2 days from now

    const newTenant = await prisma.tenant.create({
      data: {
        userId: newUser.id,
        businessName,
        whatsappNumber,
        websiteUrl: websiteUrl || null,
        botType: botType || 'business',
        systemPrompt: autoPrompt,
        businessContext: autoContext,
        
        // 🚨 DEFAULT TO QWEN FOR TRIAL USERS
        llmProvider: 'QWEN', 
        llmModel: 'qwen-plus', // or 'qwen-turbo'
        llmApiKey: llmApiKey || process.env.QWEN_API_KEY, // Use user's key OR fallback to your .env key
        llmBaseUrl: process.env.QWEN_API_URL,
        
        isHumanMode: false,  // 🚨 AI IS ON BY DEFAULT
        isActive: false,     // WhatsApp not connected yet
        plan: 'trial',
        tokenBalance: 2000,  // 2,000 trial tokens
        tokenLimit: 2000,
        trialEndsAt: trialEndsAt, 
        subscriptionStatus: 'trialing'
      }
    });

    // 6. Generate JWT
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ userId: newUser.id, role: newUser.role }, process.env.JWT_SECRET || 'your-super-secret-jwt-key', { expiresIn: '7d' });

    // 7. 🚨 SEND WELCOME EMAIL & ADMIN NOTIFICATION (SKIPPED LOCALLY TO PREVENT TIMEOUT)
  
    try {
      const { sendWelcomeEmail, sendAdminNotificationEmail } = require('./email');
      
      await sendWelcomeEmail(email, businessName, autoPassword);
      console.log(`✅ Welcome email sent to ${email}`);
      
      await sendAdminNotificationEmail(email, businessName, whatsappNumber, botType);
      console.log(`✅ Admin notification sent for ${businessName}`);
      
    } catch (emailError) {
      console.error('❌ Failed to send emails:', emailError);
    }
      console.log(`✅ Account created successfully for ${email} (Email sending skipped locally)`);

    res.json({ 
      success: true, 
      token, 
      user: { id: newUser.id, email: newUser.email, role: newUser.role },
      redirectUrl: `/connect/${whatsappNumber}`
    });
  } catch (error) {
    console.error('❌ Wizard registration error:', error);
    res.status(500).json({ error: 'Failed to create account: ' + error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    
    const result = await loginUser(email, password);
    
    // 🚨 CHECK IF PASSWORD CHANGE IS REQUIRED
    if (result.user && result.user.requiresPasswordChange) {
      return res.json({ 
        success: true, 
        message: 'Please update your password.', 
        ...result,
        requiresPasswordChange: true,
        redirectUrl: '/update-password.html'
      });
    }
    
    // Normal login
    res.json({ 
      success: true, 
      message: 'Logged in successfully!', 
      ...result,
      requiresPasswordChange: false,
      redirectUrl: '/dashboard'
    });
  } catch (error) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// ==========================================
// 🔐 UPDATE PASSWORD (Force change after first login)
// ==========================================
app.post('/api/auth/update-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    // Get user
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Verify current password
    const bcrypt = require('bcryptjs');
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        requiresPasswordChange: false // Mark as changed
      }
    });

    // Generate new JWT token
    const jwt = require('jsonwebtoken');
    const newToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      { expiresIn: '7d' }
    );

    console.log(`✅ Password updated for user: ${user.email}`);

    res.json({
      success: true,
      message: 'Password updated successfully.',
      token: newToken,
      user: {
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('❌ Update password error:', error);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// ==========================================
// 🚀 DASHBOARD ROUTES (Protected)
// ==========================================
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// 🚀 GET DASHBOARD DATA (Tenant Info & Leads)
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ 
      where: { userId: req.user.userId }
    });
    
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const leads = await prisma.lead.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json({ success: true, tenant, leads });
  } catch (error) {
    console.error('❌ Dashboard data error:', error);
    res.status(500).json({ error: 'Failed to load dashboard data.' });
  }
});

//  CHECK AGENT AVAILABILITY (Considering Active Conversations)
app.get('/api/dashboard/agents/available', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Get all available agents
    const agents = await prisma.agent.findMany({
      where: { 
        tenantId: tenant.id,
        isAvailable: true
      }
    });

    // Get all active human conversations
    const activeConversations = await prisma.conversation.findMany({
      where: {
        tenantId: tenant.id,
        mode: 'HUMAN',
        assignedAgentId: { not: null }
      },
      include: { assignedAgent: true }
    });

    // Find which agents are busy
    const busyAgentIds = activeConversations.map(c => c.assignedAgentId);
    
    // Filter to only truly available agents
    const availableAgents = agents.filter(a => !busyAgentIds.includes(a.id));

    res.json({ 
      success: true, 
      agents: availableAgents,
      busyAgents: activeConversations.map(c => ({
        agentId: c.assignedAgentId,
        agentName: c.assignedAgent?.name,
        userNumber: c.userNumber
      }))
    });
  } catch (error) {
    console.error('Check agent availability error:', error);
    res.status(500).json({ error: 'Failed to check agent availability.' });
  }
});

// 🚀 SAVE AI SETTINGS (WITH SMART WHATSAPP NUMBER CHANGE HANDLING)
app.put('/api/dashboard/settings', authenticateToken, async (req, res) => {
  try {
    const { 
      businessName,       
      whatsappNumber,     
      systemPrompt, 
      businessContext, 
      contactInfo, 
      llmApiKey, 
      llmModel, 
      llmProvider, 
      llmBaseUrl,
      isHumanMode,
      leadWebhookUrl,
      isSummaryEnabled,
      summaryTime,
      aiAgentName 
    } = req.body;

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // 🚨 1. CHECK IF WHATSAPP NUMBER IS ACTUALLY CHANGING
    const cleanNewNumber = whatsappNumber ? whatsappNumber.replace(/\D/g, '') : tenant.whatsappNumber;
    const numberChanged = cleanNewNumber && cleanNewNumber !== tenant.whatsappNumber;

    if (numberChanged) {
      console.log(`🔄 WhatsApp number changing from ${tenant.whatsappNumber} to ${cleanNewNumber}`);
      
      // 2. Disconnect old session gracefully
      const oldSock = activeSockets.get(tenant.whatsappNumber);
      if (oldSock) {
        try {
          await oldSock.logout();
        } catch (e) {
          console.log('Old socket already closed or logged out.');
        }
        activeSockets.delete(tenant.whatsappNumber);
      }
      
      // 3. Delete old auth folder so it doesn't conflict
      const oldAuthDir = path.join(__dirname, `auth_info_${tenant.whatsappNumber}`);
      if (fs.existsSync(oldAuthDir)) {
        fs.rmSync(oldAuthDir, { recursive: true, force: true });
        console.log(`🗑️ Deleted old auth folder: ${oldAuthDir}`);
      }
    }

    // 4. Update Tenant in Database
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        businessName: businessName !== undefined ? businessName : tenant.businessName,
        whatsappNumber: cleanNewNumber,
        systemPrompt: systemPrompt !== undefined ? systemPrompt : tenant.systemPrompt,
        businessContext: businessContext !== undefined ? businessContext : tenant.businessContext,
        contactInfo: contactInfo !== undefined ? contactInfo : tenant.contactInfo,
        llmApiKey: llmApiKey !== undefined ? llmApiKey : tenant.llmApiKey,
        llmModel: llmModel !== undefined ? llmModel : tenant.llmModel,
        llmProvider: llmProvider !== undefined ? llmProvider : tenant.llmProvider,
        llmBaseUrl: llmBaseUrl !== undefined ? llmBaseUrl : tenant.llmBaseUrl,
        isHumanMode: isHumanMode !== undefined ? isHumanMode : tenant.isHumanMode,
        leadWebhookUrl: leadWebhookUrl !== undefined ? leadWebhookUrl : tenant.leadWebhookUrl,
        isSummaryEnabled: isSummaryEnabled !== undefined ? isSummaryEnabled : tenant.isSummaryEnabled,
        summaryTime: summaryTime !== undefined ? summaryTime : tenant.summaryTime,
        aiAgentName: aiAgentName !== undefined ? aiAgentName : tenant.aiAgentName
      }
    });

    // 5. If number changed, start a brand new session (which will generate a new QR code)
    if (numberChanged) {
      // Import startWhatsAppSession if not already at the top (it should be)
      startWhatsAppSession(tenant.id, cleanNewNumber, handleQr, handleSuccess);
      
      return res.json({ 
        success: true, 
        message: 'Settings saved! WhatsApp number changed. Please scan the new QR code to connect.',
        needsQRScan: true,
        newNumber: cleanNewNumber
      });
    }

    res.json({ success: true, message: 'Settings saved successfully!' });
  } catch (error) {
    console.error('❌ Save settings error:', error);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

app.post('/api/dashboard/disconnect', authenticateToken, async (req, res) => {
  try {
    console.log("🔍 Disconnect attempt for userId:", req.user.userId);
    
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    
    if (!tenant) {
      console.log("❌ No tenant found for userId:", req.user.userId);
      
      // Let's see what's actually in the database to spot the mismatch
      const allTenants = await prisma.tenant.findMany({ select: { id: true, businessName: true, userId: true } });
      console.log("📊 Total tenants in DB:", allTenants.length, allTenants);
      
      return res.status(404).json({ error: 'Business not found. Please check if you are logged into the correct account, or try logging out and back in.' });
    }

    const sock = activeSockets.get(tenant.whatsappNumber);
    if (sock) {
      await sock.logout();
      activeSockets.delete(tenant.whatsappNumber);
    }

    const authDir = path.join(process.cwd(), `auth_info_${tenant.whatsappNumber}`);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

    await prisma.tenant.update({ where: { id: tenant.id }, data: { isActive: false } });
    res.json({ success: true, message: 'WhatsApp disconnected successfully.' });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

// 🚀 DELETE ACCOUNT (Ultimate Bulletproof Cleanup)
app.delete('/api/dashboard/account', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tenant = await prisma.tenant.findFirst({ where: { userId } });

    if (tenant) {
      console.log(`🗑️ Starting full account deletion for: ${tenant.businessName} (${tenant.whatsappNumber})`);

      // 🚨 1. GUARD: Prevent deletion if WhatsApp is still connected
      if (tenant.isActive) {
        return res.status(400).json({ 
          error: 'Please disconnect your WhatsApp number in Settings before deleting your account.' 
        });
      }

      // 2. Disconnect WhatsApp gracefully
      const sock = activeSockets.get(tenant.whatsappNumber);
      if (sock) { 
        try { 
          await sock.logout(); 
          console.log(`✅ Logged out WhatsApp session for ${tenant.whatsappNumber}`);
        } catch (e) { 
          console.log(`⚠️ Socket logout skipped (already closed): ${e.message}`); 
        }
        activeSockets.delete(tenant.whatsappNumber); 
      }
      
      // 3. 🚨 CRITICAL: Delete ALL possible auth folders
      const cleanNumber = tenant.whatsappNumber ? tenant.whatsappNumber.replace(/\D/g, '') : '';
      
      if (cleanNumber) {
        // Try multiple possible folder name formats
        const possibleFolders = [
          path.join(process.cwd(), `auth_info_${cleanNumber}`),
          path.join(process.cwd(), `auth_info_${tenant.whatsappNumber}`), // with + or spaces
          path.join(process.cwd(), `auth_info_${cleanNumber.slice(1)}`), // without first digit
        ];
        
        for (const folder of possibleFolders) {
          if (fs.existsSync(folder)) {
            try {
              fs.rmSync(folder, { recursive: true, force: true });
              console.log(`️ Deleted: ${folder}`);
            } catch (err) {
              console.error(`❌ Failed to delete ${folder}:`, err.message);
            }
          }
        }
      }

      // 4. 🚨 NEW: Delete uploaded Knowledge Base files for this tenant
      const knowledgeDocs = await prisma.knowledgeDocument.findMany({ 
        where: { tenantId: tenant.id },
        select: { fileName: true }
      });
      const knowledgeDir = path.join(process.cwd(), 'uploads', 'knowledge');
      
      for (const doc of knowledgeDocs) {
        const filePath = path.join(knowledgeDir, doc.fileName);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted knowledge file: ${doc.fileName}`);
          } catch (err) {
            console.error(`❌ Failed to delete knowledge file ${doc.fileName}:`, err.message);
          }
        }
      }

      // 5. Delete ALL related database records explicitly
      await prisma.knowledgeDocument.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.message.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.lead.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.conversation.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.agent.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.teamMember.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.teamInvitation.deleteMany({ where: { tenantId: tenant.id } });
      
      // 6. Finally, delete the tenant
      await prisma.tenant.delete({ where: { id: tenant.id } });
      console.log(`✅ Tenant and all DB records deleted.`);
    }
    
    // 7. Delete the user
    await prisma.user.delete({ where: { id: userId } });
    console.log(`✅ User account ${userId} permanently deleted.`);
    
    res.json({ success: true, message: 'Account and all associated data permanently deleted.' });
  } catch (error) {
    console.error('❌ Delete account fatal error:', error);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// ==========================================
// 🌐 WEBSOCKET & QR CODE ROUTES
// ==========================================
wss.on('connection', (ws) => {
  for (const [num, qr] of Object.entries(qrCache)) {
    ws.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num }));
  }
});

// 🌐 CUSTOMER-FACING QR CODE PAGE
app.get('/connect/:phoneNumber', async (req, res) => {
  const { phoneNumber } = req.params;
  
  // 🚨 NEW: Auto-start session if not already running
  if (!activeSockets.has(phoneNumber)) {
    try {
      const tenant = await prisma.tenant.findUnique({ where: { whatsappNumber: phoneNumber } });
      if (tenant) {
        console.log(`🔄 Auto-starting session for QR page visitor: ${phoneNumber}`);
        startWhatsAppSession(tenant.id, phoneNumber, handleQr, handleSuccess);
      }
    } catch (err) {
      console.error('Failed to auto-start session:', err);
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Connect WhatsApp</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
      <div class="container text-center p-10 bg-white rounded-xl shadow-lg max-w-md w-full mx-4">
        <div class="bg-red-50 border-l-4 border-red-500 p-4 mb-6 rounded-md text-left">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
              </svg>
            </div>
            <div class="ml-3">
              <p class="text-sm text-red-700 font-bold">⚠️ CRITICAL: You MUST scan this with <span class="text-red-900">${phoneNumber}</span></p>
              <p class="text-xs text-red-600 mt-1">Scanning with a different number will break the bot and trigger a security lock.</p>
            </div>
          </div>
        </div>
        
        <h1 class="text-2xl font-bold mb-2">Link your WhatsApp</h1>
        <div class="text-green-600 text-xl font-bold mb-4">${phoneNumber}</div>
        <div id="qrcode" class="mx-auto p-4 bg-white border border-gray-200 rounded-lg inline-block"><p class="text-gray-400 py-8">Generating QR Code...</p></div>
        
        <div class="text-left text-sm text-gray-600 mt-6 space-y-2">
          <p><strong>How to link:</strong></p>
          <ol class="list-decimal list-inside space-y-1">
            <li>Open WhatsApp on your phone</li>
            <li>Tap <strong>⋮</strong> or <strong>Settings</strong> > <strong>Linked Devices</strong></li>
            <li>Tap <strong>Link a Device</strong></li>
            <li>Point your phone at this screen to scan</li>
          </ol>
        </div>
        <div id="status" class="mt-6 p-3 rounded-lg font-bold text-sm bg-gray-100 text-gray-600">⏳ Waiting for QR code...</div>
      </div>

      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <script>
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
        let qrCodeObj = null;

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'qr' && data.phoneNumber === '${phoneNumber}') {
            document.getElementById('qrcode').innerHTML = '';
            qrCodeObj = new QRCode(document.getElementById('qrcode'), {
              text: data.qr, width: 220, height: 220, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.L
            });
            document.getElementById('status').textContent = '📱 Scan the QR code now';
            document.getElementById('status').className = 'mt-6 p-3 rounded-lg font-bold text-sm bg-blue-50 text-blue-700';
          }
          // In the WebSocket onmessage handler, add this:
if (data.type === 'success' && data.phoneNumber === '${phoneNumber}') {
  document.getElementById('status').className = 'mt-6 p-3 rounded-lg font-bold text-sm bg-green-100 text-green-700';
  document.getElementById('status').textContent = '✅ Connected successfully! Redirecting to dashboard...';
  document.getElementById('qrcode').innerHTML = '<div class="text-6xl text-green-500">✓</div>';
  
  // 🚨 AUTO-REDIRECT TO DASHBOARD AFTER 2 SECONDS
  setTimeout(() => {
    window.location.href = '/dashboard';
  }, 2000);
}
        };
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// 🌐 STATIC PAGES & LEGACY ROUTES
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')); // The new Landing Page
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html')); // The new 3-Step Wizard
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'accept-invitation.html'));
});


app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html'));
});

// 🚀 FORGOT PASSWORD - Generate & Email Temporary Password (Simple & Safe)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    console.log(` Forgot password request for: ${email}`);
    
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log(`⚠️ User not found: ${email} (returning success for security)`);
      return res.json({ success: true, message: 'If an account with this email exists, a new password has been sent to your inbox.' });
    }

    // 1. Generate a simple, 8-character temporary password
    const crypto = require('crypto');
    const tempPassword = crypto.randomBytes(4).toString('hex'); // e.g., "a1b2c3d4"
    console.log(` Generated temporary password for ${email}`);
    
    // 2. Hash it and save ONLY the password to the database (NO resetToken!)
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    
// Inside /api/auth/forgot-password:
await prisma.user.update({
  where: { id: user.id },
  data: { 
    password: hashedPassword,
    requiresPasswordChange: true //  FORCE CHANGE ON NEXT LOGIN
  }
});

    // 3. Send the email using your email.js function
    const { sendPasswordResetEmail } = require('./email');
    await sendPasswordResetEmail(email, tempPassword);
    console.log(`✅ Password reset email sent to ${email}`);

    res.json({ success: true, message: 'If an account with this email exists, a new password has been sent to your inbox.' });
  } catch (error) {
    console.error(' Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

const handleQr = (num, qr) => {
  qrCache[num] = qr;
  wss.clients.forEach(client => { 
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'qr', qr, phoneNumber: num })); 
  });
};

const handleSuccess = (num) => {
  delete qrCache[num];
  wss.clients.forEach(client => { 
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'success', phoneNumber: num })); 
  });
};

app.post('/api/connect', async (req, res) => {
  try {
    const { businessName, whatsappNumber } = req.body;
    const formattedNumber = whatsappNumber.replace(/\D/g, ''); 
    const tenant = await prisma.tenant.upsert({
      where: { whatsappNumber: formattedNumber },
      update: { businessName },
      create: { 
        businessName, 
        whatsappNumber: formattedNumber,
        systemPrompt: "أنت مساعد ذكي ولطيف. رد باختصار وبشكل احترافي."
      }
    });
    startWhatsAppSession(tenant.id, formattedNumber, handleQr, handleSuccess);
    res.json({ success: true, message: "Session started. Visit /connect/" + formattedNumber + " to scan.", tenantId: tenant.id });
  } catch (error) {
    console.error("❌ Connection Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const { scrapeWebsiteContext } = require('./scraper'); // Add this at the top with other requires

// ... (keep all your existing routes) ...


// 🚀 UNIVERSAL FULL WEBSITE SCRAPER (Crawls ALL pages for ANY business)
app.post('/api/dashboard/scrape-website', authenticateToken, async (req, res) => {
  try {
    const { websiteUrl } = req.body;
    if (!websiteUrl) return res.status(400).json({ error: 'Website URL is required.' });

    let baseUrl = websiteUrl;
    if (!baseUrl.startsWith('http')) {
      baseUrl = 'https://' + baseUrl;
    }

    console.log(`🕷️ Starting FULL website crawl of: ${baseUrl}`);

    const crawledPages = new Set();
    const pagesToCrawl = [baseUrl];
    const maxPages = 50; // Safety limit to prevent infinite loops
    const maxTotalChars = 15000; // Prevent LLM token overflow
    let totalCollectedText = '';

    while (pagesToCrawl.length > 0 && crawledPages.size < maxPages && totalCollectedText.length < maxTotalChars) {
      const currentPage = pagesToCrawl.shift();
      
      if (crawledPages.has(currentPage)) continue;
      crawledPages.add(currentPage);

      try {
        const response = await axios.get(currentPage, { 
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          timeout: 10000 
        });
        
        const $ = cheerio.load(response.data);
        // Remove non-content elements to get clean text
        $('script, style, nav, footer, header, iframe, noscript, svg').remove();
        
        // Extract meaningful content
        const title = $('title').text().trim();
        const headings = $('h1, h2, h3, h4').map((i, el) => $(el).text().trim()).get().join('. ');
        const paragraphs = $('p, li, td').map((i, el) => $(el).text().trim()).get().join('. ');
        
        const pageContent = `PAGE: ${title || currentPage}\nHeadings: ${headings}\nContent: ${paragraphs}`;
        totalCollectedText += `\n\n---\n${pageContent}`;

        // Find all internal links to crawl next
        $('a').each((i, el) => {
          const href = $(el).attr('href');
          if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('javascript:') && !href.endsWith('.pdf') && !href.endsWith('.jpg') && !href.endsWith('.png') && !href.endsWith('.zip')) {
            try {
              const absoluteUrl = new URL(href, baseUrl).toString();
              // Only crawl links that belong to the same domain
              const baseDomain = new URL(baseUrl).hostname;
              const linkDomain = new URL(absoluteUrl).hostname;
              
              if (!crawledPages.has(absoluteUrl) && linkDomain === baseDomain) {
                pagesToCrawl.push(absoluteUrl);
              }
            } catch (e) {
              // Ignore invalid URLs
            }
          }
        });

        console.log(`✅ Crawled ${crawledPages.size} pages so far...`);
        
      } catch (err) {
        console.log(`⚠️ Skipped ${currentPage}: ${err.message}`);
      }
    }

    // 🌐 UNIVERSAL DYNAMIC PROMPT (Works for ANY business, agency, or personal site)
    const generatedContext = `🌐 COMPREHENSIVE WEBSITE INFORMATION

This is the COMPLETE information scraped from the business website: ${baseUrl} 
(Total pages crawled: ${crawledPages.size})

Use this detailed information to answer ALL customer questions accurately and professionally:

${totalCollectedText.substring(0, maxTotalChars)}

---
🤖 STRICT INSTRUCTIONS FOR THE AI AGENT:
1. Answer questions based ONLY on the information provided above.
2. Adopt the tone and branding of the business based on the scraped content.
3. If a specific detail (like exact pricing, hours, or future dates) is NOT mentioned in the text above, politely state that the customer should contact the business directly for the most current information. Do NOT make up or hallucinate facts.
4. Be professional, helpful, concise, and accurate.
5. If the user asks for contact info, extract it from the scraped text above.`;

    res.json({ 
      success: true, 
      generatedContext,
      message: `✅ Successfully crawled ${crawledPages.size} pages from ${baseUrl}!`
    });

  } catch (error) {
    console.error('❌ Full scrape error:', error);
    res.status(500).json({ error: 'Failed to scrape website. Please check the URL and ensure it is accessible.' });
  }
});

// Helper to pick the best model from a list
function pickBestModel(models, provider) {
  // Filter for text/chat models (ignore image/audio models)
  const chatModels = models.filter(m => 
    m.id.toLowerCase().includes('chat') || 
    m.id.toLowerCase().includes('gpt') || 
    m.id.toLowerCase().includes('qwen') ||
    m.id.toLowerCase().includes('turbo') ||
    m.id.toLowerCase().includes('mini')
  );
  
  const candidates = chatModels.length > 0 ? chatModels : models;
  if (candidates.length === 0) return null;

  // Priority logic based on provider
  if (provider === 'OPENAI') {
    // Prefer gpt-4o-mini (smart & cheap), then gpt-4o, then gpt-3.5
    const priority = ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
    for (let p of priority) {
      const found = candidates.find(m => m.id === p);
      if (found) return found.id;
    }
  }
  
  if (provider === 'QWEN') {
    // Prefer qwen-plus (best balance), qwen-max, qwen-turbo
    const priority = ['qwen-plus', 'qwen-max', 'qwen-turbo'];
    for (let p of priority) {
      const found = candidates.find(m => m.id === p);
      if (found) return found.id;
    }
  }

  // Fallback to the first available model
  return candidates[0].id;
}

// 🚀 SMART VALIDATE & AUTO-DETECT LLM API KEY
app.post('/api/dashboard/validate-llm', authenticateToken, async (req, res) => {
  try {
    const { llmApiKey } = req.body;
    if (!llmApiKey) return res.status(400).json({ error: 'API Key is required' });

    let detectedModel = null;
    let provider = 'UNKNOWN';
    let baseUrl = null;

    // 1. Try OpenAI
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${llmApiKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        detectedModel = pickBestModel(data.data, 'OPENAI');
        if (detectedModel) {
          provider = 'OPENAI';
          baseUrl = 'https://api.openai.com/v1';
        }
      }
    } catch (e) { /* ignore */ }

    // 2. If not OpenAI, try Qwen (DashScope)
    if (!detectedModel) {
      try {
        const response = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', {
          headers: { 'Authorization': `Bearer ${llmApiKey}` }
        });
        if (response.ok) {
          const data = await response.json();
          detectedModel = pickBestModel(data.data, 'QWEN');
          if (detectedModel) {
            provider = 'QWEN';
            baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (detectedModel) {
      res.json({ 
        success: true, 
        detectedModel, 
        provider, 
        baseUrl,
        message: `✅ Valid ${provider} Key! Auto-selected best model: ${detectedModel}` 
      });
    } else {
      res.status(400).json({ error: ' Invalid API Key or no chat models found.' });
    }
  } catch (error) {
    console.error('Validate LLM error:', error);
    res.status(500).json({ error: 'Failed to validate API key.' });
  }
});

// 🚀 NEW: Auto-start all active WhatsApp sessions when the server boots up
async function startAllActiveSessions() {
  try {
    const activeTenants = await prisma.tenant.findMany({ where: { isActive: true } });
    console.log(`🔄 Found ${activeTenants.length} active tenant(s). Starting sessions...`);
    
    for (const tenant of activeTenants) {
      console.log(`🔄 Auto-starting session for: ${tenant.whatsappNumber}`);
      startWhatsAppSession(tenant.id, tenant.whatsappNumber, handleQr, handleSuccess);
    }
  } catch (error) {
    console.error('❌ Failed to start active sessions:', error);
  }
}

// 🚀 AUTOPILOT DAILY BRIEF ROUTE (Protected)
app.post('/api/dashboard/daily-summary', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    // 1. Get today's messages
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todaysMessages = await prisma.message.findMany({
      where: { tenantId: tenant.id, createdAt: { gte: startOfDay } },
      orderBy: { createdAt: 'asc' }
    });

    if (todaysMessages.length === 0) {
      return res.json({ success: true, summary: "📊 No messages received today! Time to run some marketing campaigns." });
    }

    // 2. Format messages for AI
    const chatLog = todaysMessages.map(m => `[${m.direction === 'inbound' ? 'Customer' : 'AI/Bot'}] ${m.fromNumber}: ${m.content}`).join('\n');

    // 3. Generate Summary using AI
    const systemPrompt = "You are an executive assistant to the business owner. Summarize the following daily WhatsApp chat logs into a brief, professional daily brief. Highlight: 1. Total number of interactions. 2. Key lead inquiries or services requested. 3. Any unresolved issues. Keep it concise, use bullet points, and maintain a professional tone.";
    const { getAIResponse } = require('./ai');
    const summary = await getAIResponse(chatLog, systemPrompt, tenant);

    // 4. Send to WhatsApp "Message Yourself"
    const sock = activeSockets.get(tenant.whatsappNumber);
    if (sock) {
      try {
        // Use the bot's own number as the JID for "Message Yourself"
        const selfJid = `${tenant.whatsappNumber}@s.whatsapp.net`;
        console.log(` Sending summary to self JID: ${selfJid}`);
        
        await sock.sendMessage(selfJid, { 
          text: `📊 *Daily AI Summary for ${tenant.businessName}*\n\n${summary}` 
        });
        console.log('✅ Summary sent to WhatsApp "Message Yourself"');
      } catch (waError) {
        console.error("⚠️ Could not send to WhatsApp 'Message Yourself':", waError.message);
      }
    } else {
      console.log("⚠️ No active socket found for this tenant");
    }

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Daily summary error:', error);
    res.status(500).json({ error: 'Failed to generate daily summary.' });
  }
});


// 🚀 AUTO-SAVE HUMAN TAKEOVER TOGGLE
app.patch('/api/dashboard/toggle-human-mode', authenticateToken, async (req, res) => {
  try {
    const { isHumanMode } = req.body;
    console.log(`🔄 Toggling Human Mode to: ${isHumanMode} for user: ${req.user.userId}`);

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { isHumanMode: Boolean(isHumanMode) }
    });

    res.json({ success: true, isHumanMode: Boolean(isHumanMode) });
  } catch (error) {
    console.error('❌ Toggle human mode error:', error);
    res.status(500).json({ error: 'Failed to toggle mode.' });
  }
});

// 🚀 CRM: Get All Leads
app.get('/api/dashboard/leads', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });
    
    const leads = await prisma.lead.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, leads });
  } catch (error) {
    console.error('❌ Fetch leads error:', error);
    res.status(500).json({ error: 'Failed to fetch leads.' });
  }
});

// 🚀 CRM: Update Lead Status or Notes
app.patch('/api/dashboard/leads/:id', authenticateToken, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    
    // Verify ownership
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, tenantId: tenant.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    const updatedLead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { 
        status: status || lead.status,
        notes: notes !== undefined ? notes : lead.notes
      }
    });
    res.json({ success: true, lead: updatedLead });
  } catch (error) {
    console.error('❌ Update lead error:', error);
    res.status(500).json({ error: 'Failed to update lead.' });
  }
});

// 🚀 TEAM: Get All Clients (Tenants) for the User
app.get('/api/dashboard/clients', authenticateToken, async (req, res) => {
  try {
    const clients = await prisma.tenant.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, clients });
  } catch (error) {
    console.error('❌ Fetch clients error:', error);
    res.status(500).json({ error: 'Failed to fetch clients.' });
  }
});

// 🚀 TEAM: Invite Agent (Creates DB Record + Sends Email)
app.post('/api/dashboard/team/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Check if already a team member
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const existingMember = await prisma.teamMember.findFirst({
        where: { tenantId: tenant.id, userId: existingUser.id }
      });
      if (existingMember) {
        return res.status(400).json({ error: 'This user is already a team member.' });
      }
      // Auto-add existing user
      await prisma.teamMember.create({
        data: { tenantId: tenant.id, userId: existingUser.id, role: 'AGENT' }
      });
      return res.json({ success: true, message: `${email} added as agent successfully!` });
    }

    // Check for pending invitation
    const pendingInvite = await prisma.teamInvitation.findFirst({
      where: { email, tenantId: tenant.id, accepted: false, expiresAt: { gt: new Date() } }
    });
    if (pendingInvite) {
      return res.json({ success: true, message: `Invitation already sent to ${email}. Link expires in 7 days.` });
    }

    // Create invitation record
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.teamInvitation.create({
      data: { email, tenantId: tenant.id, token, expiresAt }
    });

    // Send email
    const inviteLink = `https://bot.aamirsaba.com/accept-invitation?email=${encodeURIComponent(email)}&token=${token}`;
    const { sendAgentInvitationEmail } = require('./email');
    await sendAgentInvitationEmail(email, tenant.businessName, inviteLink);

    res.json({ success: true, message: `Invitation email sent to ${email}.` });
  } catch (error) {
    console.error(' Invite error:', error);
    res.status(500).json({ error: 'Failed to invite agent.' });
  }
});

// 🚀 TEAM: Get Team Members
app.get('/api/dashboard/team', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const members = await prisma.teamMember.findMany({
      where: { tenantId: tenant.id },
      include: { 
        user: { 
          select: { id: true, email: true, role: true } 
        } 
      }
    });

    res.json({ success: true, members });
  } catch (error) {
    console.error('❌ Fetch team error:', error);
    res.status(500).json({ error: 'Failed to fetch team members.' });
  }
});

//  LIVE INBOX: Send Manual Reply via WhatsApp
app.post('/api/dashboard/send-message', authenticateToken, async (req, res) => {
  try {
    const { toNumber, content, tenantId } = req.body;
    
    const tenant = await prisma.tenant.findFirst({ 
      where: { id: tenantId || req.query.tenantId, userId: req.user.userId } 
    });
    if (!tenant) return res.status(403).json({ error: 'Access denied.' });

    const sock = activeSockets.get(tenant.whatsappNumber);
    if (!sock) return res.status(400).json({ error: 'WhatsApp is not connected.' });

    const jid = `${toNumber}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: content });

    await prisma.message.create({
      data: {
        tenantId: tenant.id,
        fromNumber: tenant.whatsappNumber,
        toNumber: toNumber,
        direction: 'outbound',
        content: content,
        isAiReply: false
      }
    });

    res.json({ success: true, message: 'Message sent!' });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// 🚀 DASHBOARD: Get Analytics for Charts
app.get('/api/dashboard/analytics', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Get last 7 days of messages
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const messages = await prisma.message.findMany({
      where: { tenantId: tenant.id, createdAt: { gte: sevenDaysAgo } },
      orderBy: { createdAt: 'asc' }
    });

    const leads = await prisma.lead.findMany({
      where: { tenantId: tenant.id, createdAt: { gte: sevenDaysAgo } },
      orderBy: { createdAt: 'asc' }
    });

    // Group by date (simplified for chart.js)
    const labels = [];
    const messageCounts = [];
    const leadCounts = [];
    
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      labels.push(dateStr);
      
      const dayStart = new Date(d.setHours(0,0,0,0));
      const dayEnd = new Date(d.setHours(23,59,59,999));
      
      messageCounts.push(messages.filter(m => m.createdAt >= dayStart && m.createdAt <= dayEnd).length);
      leadCounts.push(leads.filter(l => l.createdAt >= dayStart && l.createdAt <= dayEnd).length);
    }

    res.json({ 
      success: true, 
      chartData: { labels, messageCounts, leadCounts } 
    });
  } catch (error) {
    console.error('❌ Analytics error:', error);
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});


//  MANAGE SERVICE ZONES
app.put('/api/dashboard/service-areas', authenticateToken, async (req, res) => {
  try {
    const { areas } = req.body; // Expects an array of strings
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Save as JSON string
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { serviceAreas: JSON.stringify(areas) }
    });

    res.json({ success: true, message: 'Service zones updated!' });
  } catch (error) {
    console.error('❌ Update service areas error:', error);
    res.status(500).json({ error: 'Failed to update zones.' });
  }
});

// 🚀 CHANGE PASSWORD ENDPOINT
app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const bcrypt = require('bcryptjs');
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    await prisma.user.update({
      where: { id: user.id },
      data: { 
        password: hashedPassword,
        requiresPasswordChange: false
      }
    });

    try {
      const { sendPasswordResetEmail } = require('./email');
      await sendPasswordResetEmail(user.email, newPassword);
    } catch (emailError) {
      console.error('❌ Failed to send confirmation email:', emailError);
    }

    res.json({ success: true, message: 'Password changed successfully!' });
  } catch (error) {
    console.error('❌ Change password error:', error);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

// 🚀 FETCH AVAILABLE MODELS FOR A GIVEN PROVIDER
app.post('/api/fetch-models', authenticateToken, async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'Provider and API Key are required.' });
    }

    let models = [];

    // 1. HARDCODED FALLBACKS FOR PROVIDERS WITHOUT STANDARD /models ENDPOINTS
    if (provider === 'anthropic') {
      return res.json({ 
        success: true,
        models: [
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', isRecommended: true },
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', isRecommended: false }
        ] 
      });
    } 
    
    if (provider === 'google') {
      return res.json({
        success: true,
        models: [
          { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', isRecommended: true },
          { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', isRecommended: false }
        ]
      });
    }

    // 2. DEFINE BASE URL FOR FETCHABLE PROVIDERS
    let baseUrl = '';
    if (provider === 'openai') {
      baseUrl = 'https://api.openai.com/v1';
    } else if (provider === 'deepseek') {
      baseUrl = 'https://api.deepseek.com/v1';
    } else if (provider === 'alibaba' || provider === 'qwen') {
      baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    } else if (provider === 'groq') {
      baseUrl = 'https://api.groq.com/openai/v1';
    } else {
      return res.status(400).json({ error: 'Unsupported provider for model fetching.' });
    }

    // 3. FETCH MODELS FROM PROVIDER
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (response.ok) {
        const data = await response.json();
        const rawModels = data.data || [];
        
        models = rawModels.map(m => {
          const isRecommended = m.id.includes('gpt-4o') || m.id.includes('deepseek-chat') || m.id.includes('llama-3') || m.id.includes('qwen-plus');
          return { id: m.id, name: m.id, isRecommended: isRecommended };
        }).filter(m => 
          m.id.includes('chat') || m.id.includes('gpt') || m.id.includes('qwen') || 
          m.id.includes('deepseek') || m.id.includes('llama') || m.id.includes('claude') || m.id.includes('gemini')
        );

        models.sort((a, b) => (b.isRecommended === a.isRecommended) ? 0 : b.isRecommended ? 1 : -1);
        models = models.slice(0, 20); // Limit to top 20
      }
    } catch (fetchError) {
      console.log('Fetch models endpoint failed, using fallbacks:', fetchError.message);
    }

    // 4. FINAL FALLBACK IF FETCH FAILED BUT KEY MIGHT BE VALID
    if (models.length === 0) {
      if (provider === 'openai') {
        models = [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini', isRecommended: true }, { id: 'gpt-4o', name: 'GPT-4o', isRecommended: false }];
      } else if (provider === 'deepseek') {
        models = [{ id: 'deepseek-chat', name: 'DeepSeek V3', isRecommended: true }];
      } else if (provider === 'alibaba' || provider === 'qwen') {
        models = [{ id: 'qwen-plus', name: 'Qwen Plus', isRecommended: true }, { id: 'qwen-max', name: 'Qwen Max', isRecommended: false }];
      } else if (provider === 'groq') {
        models = [{ id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B', isRecommended: true }];
      }
    }

    if (models.length === 0) {
      return res.status(400).json({ error: 'No chat models found. Please check your API Key.' });
    }

    res.json({ success: true, models });
  } catch (error) {
    console.error('Fetch models error:', error);
    res.status(500).json({ error: 'Failed to fetch models.' });
  }
});

// 🚀 TEAM: Invite Agent to Tenant
app.post('/api/dashboard/team/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    // Check if user exists
    const userToAdd = await prisma.user.findUnique({ where: { email } });
    if (!userToAdd) {
      return res.status(404).json({ error: 'User with this email does not exist. They must register first.' });
    }

    // Check if already added as team member
    const existingMember = await prisma.teamMember.findFirst({
      where: { 
        tenantId: tenant.id, 
        userId: userToAdd.id 
      }
    });

    if (existingMember) {
      return res.status(400).json({ error: 'This user is already a team member.' });
    }

    // Add as team member
    await prisma.teamMember.create({
      data: { 
        tenantId: tenant.id, 
        userId: userToAdd.id, 
        role: 'AGENT' 
      }
    });

    res.json({ success: true, message: 'Agent invited successfully!' });
  } catch (error) {
    console.error('❌ Invite agent error:', error);
    res.status(500).json({ error: 'Failed to invite agent.' });
  }
});

// 🚀 TEAM: Get Team Members
app.get('/api/dashboard/team', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const members = await prisma.teamMember.findMany({
      where: { tenantId: tenant.id },
      include: { 
        user: { 
          select: { 
            id: true,
            email: true,
            role: true 
          } 
        } 
      }
    });

    res.json({ success: true, members });
  } catch (error) {
    console.error('❌ Fetch team error:', error);
    res.status(500).json({ error: 'Failed to fetch team members.' });
  }
});


//  ACCEPT INVITATION: Create account + add to team + auto-login
app.post('/api/auth/accept-invitation', async (req, res) => {
  try {
    const { email, token, password } = req.body;
    if (!email || !token || !password) {
      return res.status(400).json({ error: 'Email, token, and password are required.' });
    }

    // Verify invitation
    const invitation = await prisma.teamInvitation.findFirst({
      where: { email, token, accepted: false, expiresAt: { gt: new Date() } },
      include: { tenant: { select: { id: true, businessName: true } } }
    });

    if (!invitation) {
      return res.status(400).json({ error: 'Invalid or expired invitation link.' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    
    if (existingUser) {
      // User exists - just add them to the team if not already
      const existingMember = await prisma.teamMember.findFirst({
        where: { tenantId: invitation.tenantId, userId: existingUser.id }
      });

      if (!existingMember) {
        await prisma.teamMember.create({
          data: { tenantId: invitation.tenantId, userId: existingUser.id, role: 'AGENT' }
        });
      }

      // Update agent to available
      await prisma.agent.updateMany({
        where: { email: existingUser.email, tenantId: invitation.tenantId },
        data: { isAvailable: true }
      });

      // Mark invitation as accepted
      await prisma.teamInvitation.update({
        where: { id: invitation.id },
        data: { accepted: true }
      });

      // Generate JWT token
      const jwt = require('jsonwebtoken');
      const authToken = jwt.sign(
        { userId: existingUser.id, email: existingUser.email, role: existingUser.role },
        process.env.JWT_SECRET || 'your-secret-key-change-this',
        { expiresIn: '7d' }
      );

      return res.json({ 
        success: true, 
        message: '✅ Welcome back! You have been added to the team.',
        token: authToken,
        user: { email: existingUser.email, role: existingUser.role },
        redirectUrl: '/agent-dashboard'
      });
    }

    // New user - create account
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: { email, password: hashedPassword, role: 'AGENT' }
    });

    // Add to team
    await prisma.teamMember.create({
      data: { tenantId: invitation.tenantId, userId: newUser.id, role: 'AGENT' }
    });

    // Update agent to available
    await prisma.agent.updateMany({
      where: { email: newUser.email, tenantId: invitation.tenantId },
      data: { isAvailable: true }
    });

    // Mark invitation as accepted
    await prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: { accepted: true }
    });

    // Generate JWT token
    const jwt = require('jsonwebtoken');
    const authToken = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      { expiresIn: '7d' }
    );

    res.json({ 
      success: true, 
      message: '✅ Account created and added to team! Redirecting...',
      token: authToken,
      user: { email: newUser.email, role: newUser.role },
      redirectUrl: '/agent-dashboard'
    });
  } catch (error) {
    console.error('❌ Accept invitation error:', error);
    res.status(500).json({ error: 'Failed to accept invitation.' });
  }
});


//  AGENT: Get team chats
app.get('/api/agent/chats', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ 
      where: { id: req.user.userId },
      include: { 
        teamMemberships: { 
          include: { 
            tenant: { 
              include: { 
                messages: {
                  orderBy: { createdAt: 'desc' },
                  take: 50
                }
              }
            }
          }
        }
      }
    });

    if (!user || user.teamMemberships.length === 0) {
      return res.status(404).json({ error: 'No team access found.' });
    }

    // Get all messages from tenant(s)
    const allMessages = [];
    user.teamMemberships.forEach(membership => {
      allMessages.push(...membership.tenant.messages);
    });

    // Group by phone number
    const chatsMap = new Map();
    allMessages.forEach(msg => {
      if (msg.direction === 'inbound') {
        if (!chatsMap.has(msg.fromNumber)) {
          chatsMap.set(msg.fromNumber, {
            phoneNumber: msg.fromNumber,
            lastMessage: msg.content,
            createdAt: msg.createdAt
          });
        }
      }
    });

    const chats = Array.from(chatsMap.values()).sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json({ success: true, chats });
  } catch (error) {
    console.error(' Agent chats error:', error);
    res.status(500).json({ error: 'Failed to load chats.' });
  }
});

// 🚨 AGENT SEND MESSAGE (UNIVERSAL TRANSLATOR)
app.post('/api/agent/send-message', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    const agent = await prisma.agent.findFirst({ 
      where: { email: req.user.email },
      include: { tenant: true }
    });
    if (!agent || !agent.tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const sock = activeSockets.get(agent.tenant.whatsappNumber);
    if (!sock) return res.status(500).json({ error: 'WhatsApp not connected.' });

    // Get last customer message to detect THEIR language
    const lastUserMsg = await prisma.message.findFirst({
      where: { tenantId: agent.tenantId, fromNumber: phoneNumber, toNumber: agent.tenant.whatsappNumber },
      orderBy: { createdAt: 'desc' }
    });

    let finalMessage = message;
    
    if (lastUserMsg) {
      // 🚨 SMART PROMPT: Translate agent's reply to the customer's detected language
      const detectPrompt = `Detect the language of this reference text: "${lastUserMsg.content}". Then, translate the following message into that exact same language. Only output the translated text.\n\nMessage to translate: "${message}"`;
      
      finalMessage = await translateText(
        detectPrompt,
        'Detected Language',
        agent.tenant.llmProvider,
        agent.tenant.llmApiKey,
        agent.tenant.llmModel,
        agent.tenant.llmBaseUrl
      );
    }

    await sock.sendMessage(phoneNumber + '@s.whatsapp.net', { text: finalMessage });

    // Save the ENGLISH (or agent's preferred) version to DB so the agent can read their own history
    await prisma.message.create({
      data: {
        tenantId: agent.tenantId,
        fromNumber: agent.tenant.whatsappNumber,
        toNumber: phoneNumber,
        direction: 'outbound',
        content: message, // Save original agent input
        isAiReply: false
      }
    });

    res.json({ success: true, message: 'Message sent.' });
  } catch (error) {
    console.error('Agent send message error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// 🚨 GET CHAT HISTORY FOR AGENT (WITH UNIVERSAL TRANSLATION)
app.get('/api/agent/chat-history/:number', authenticateToken, async (req, res) => {
  try {
    const { number } = req.params;
    const targetLang = req.query.lang || 'English'; // 🚨 Get agent's chosen language
    
    const agent = await prisma.agent.findFirst({ 
      where: { email: req.user.email },
      include: { tenant: true }
    });
    if (!agent || !agent.tenant) return res.status(403).json({ error: 'Agent not found.' });

    const messages = await prisma.message.findMany({
      where: {
        tenantId: agent.tenantId,
        OR: [
          { fromNumber: number, toNumber: agent.tenant.whatsappNumber },
          { fromNumber: agent.tenant.whatsappNumber, toNumber: number }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: 50
    });

    const translatedMessages = [];
    for (const msg of messages) {
      if (msg.direction === 'inbound') {
        try {
          // 🚨 SMART PROMPT: Translate ONLY if it's not already in the agent's preferred language
          const prompt = `Detect the language of this text. If it is NOT ${targetLang}, translate it to ${targetLang}. If it is already in ${targetLang}, return it exactly as is. Do not add any extra text.\n\nText: "${msg.content}"`;
          
          const translated = await translateText(
            prompt, 
            targetLang, 
            agent.tenant.llmProvider, 
            agent.tenant.llmApiKey, 
            agent.tenant.llmModel,
            agent.tenant.llmBaseUrl
          );
          
          msg.displayContent = translated;
          msg.originalContent = msg.content;
          msg.isTranslated = (translated !== msg.content);
        } catch (err) {
          msg.displayContent = msg.content;
          msg.isTranslated = false;
        }
      } else {
        // Outbound: Always show what the agent originally typed
        msg.displayContent = msg.content;
        msg.originalContent = null;
        msg.isTranslated = false;
      }
      translatedMessages.push(msg);
    }

    res.json({ success: true, messages: translatedMessages });
  } catch (error) {
    console.error('Load chat history error:', error);
    res.status(500).json({ error: 'Failed to load chat history.' });
  }
});

app.post('/api/agent/update-preference', authenticateToken, async (req, res) => {
  try {
    const { preferredLanguage } = req.body;
    await prisma.agent.updateMany({
      where: { email: req.user.email },
      data: { preferredLanguage }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update preference.' });
  }
});

//  DASHBOARD: Get ALL conversations across all numbers
app.get('/api/dashboard/all-conversations', authenticateToken, async (req, res) => {
  try {
    const { phone, days } = req.query;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Build query
    const query = {
      tenantId: tenant.id
    };

    // Filter by date
    if (days && days !== 'all') {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - parseInt(days));
      query.createdAt = { gte: daysAgo };
    }

    // Filter by phone number if provided
    if (phone) {
      query.OR = [
        { fromNumber: { contains: phone } },
        { toNumber: { contains: phone } }
      ];
    } else {
      // Get all messages for this tenant
      query.OR = [
        { fromNumber: tenant.whatsappNumber },
        { toNumber: tenant.whatsappNumber }
      ];
    }

    // Fetch messages
    const messages = await prisma.message.findMany({
      where: query,
      orderBy: { createdAt: 'desc' },
      take: 500
    });

    res.json({ success: true, messages });
  } catch (error) {
    console.error('All conversations error:', error);
    res.status(500).json({ error: 'Failed to load all conversations.' });
  }
});

//  Serve agent dashboard
app.get('/agent-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'agent-dashboard.html'));
});

// 🚨 AGENT: Get my info
app.get('/api/agent/info', authenticateToken, async (req, res) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { email: req.user.email },
      include: {
        tenant: {
          select: {
            businessName: true,
            whatsappNumber: true
          }
        }
      }
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found. Please contact your admin.' });
    }

    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        isAvailable: agent.isAvailable,
        isBusy: agent.isBusy,
        preferredLanguage: agent.preferredLanguage || 'English'
      },
      team: agent.tenant ? {
        businessName: agent.tenant.businessName,
        whatsappNumber: agent.tenant.whatsappNumber
      } : null
    });
  } catch (error) {
    console.error('Agent info error:', error);
    res.status(500).json({ error: 'Failed to load agent info.' });
  }
});


// 🚀 UPLOAD KNOWLEDGE BASE (Ultra-Bulletproof PDF/TXT Support with OCR)
app.post('/api/dashboard/upload-knowledge', authenticateToken, knowledgeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a file.' });

    // 🚨 1. ENSURE DIRECTORY EXISTS (Prevents Multer crashes)
    const uploadDir = path.join(__dirname, '..', 'uploads', 'knowledge');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log('📁 Created missing uploads/knowledge directory');
    }

    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    let extractedText = '';
    const filePath = req.file.path;
    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
    
    // 🚨 2. SAFE FILE PARSING WITH OCR FALLBACK
    if (fileExtension === 'pdf') {
      try {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        extractedText = data.text || '';
        
        // 🚨 OCR FALLBACK: If standard parse finds almost no text, it's likely a scanned image PDF
        if (extractedText.trim().length < 50) {
          console.log('⚠️ PDF appears to be image-based. Initiating OCR fallback (this may take 15-30 seconds)...');
          
          const tempDir = path.join(__dirname, '..', 'uploads', 'temp_ocr');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const options = {
            density: 300,
            saveFilename: "ocr_temp",
            savePath: tempDir,
            format: "png",
            width: 2000,
            height: 2000
          };
          
          // 🚨 CORRECT USAGE: Use fromPath instead of convert
          const storeAsImage = fromPath(filePath, options);
          const pages = await storeAsImage.bulk(-1); // Convert all pages
          
          let ocrText = '';
          for (const page of pages) {
            console.log(`🔍 Running OCR on page ${page.page}...`);
            const { data: { text } } = await Tesseract.recognize(page.path, 'eng');
            ocrText += text + '\n';
            
            // Clean up temp image immediately to save disk space
            if (page.path && fs.existsSync(page.path)) {
              fs.unlinkSync(page.path);
            }
          }
          
          extractedText = ocrText;
          console.log('✅ OCR completed successfully.');
        }
      } catch (pdfError) {
        console.error('❌ PDF Parse Error:', pdfError.message);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'Could not extract text. The PDF might be a scanned image, password-protected, or corrupted.' });
      }
    } 
    else if (fileExtension === 'txt') {
      try {
        extractedText = fs.readFileSync(filePath, 'utf8');
      } catch (txtError) {
        console.error('❌ TXT Read Error:', txtError.message);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'Could not read the text file. It may have unsupported encoding.' });
      }
    } 
    else {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Only PDF and TXT files are allowed.' });
    }

    // Clean up the extracted text
    extractedText = extractedText.replace(/\s+/g, ' ').trim();

    if (extractedText.length < 10) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Could not extract enough text. File might be image-based or empty.' });
    }

    // 🚨 3. SAVE AS A NEW DOCUMENT
    await prisma.knowledgeDocument.create({
      data: {
        tenantId: tenant.id,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        content: extractedText
      }
    });

    console.log(`✅ Successfully uploaded and trained on: ${req.file.originalname}`);
    
    res.json({ 
      success: true, 
      message: `✅ Successfully uploaded "${req.file.originalname}"!`
    });
    
  } catch (error) {
    // 🚨 4. EXACT ERROR LOGGING (This will tell us exactly what is failing)
    console.error('❌ Upload knowledge FATAL error:', error.message);
    
    // Try to clean up the file on fatal error
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    res.status(500).json({ error: 'Failed to process file: ' + error.message });
  }
});

// 🚀 OWNER DASHBOARD: Get recent chats
app.get('/api/dashboard/chats', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ 
      where: { userId: req.user.userId },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 50
        }
      }
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    // Group messages by phone number (only inbound)
    const chatsMap = new Map();
    tenant.messages.forEach(msg => {
      if (msg.direction === 'inbound') {
        if (!chatsMap.has(msg.fromNumber)) {
          chatsMap.set(msg.fromNumber, {
            phoneNumber: msg.fromNumber,
            lastMessage: msg.content,
            createdAt: msg.createdAt
          });
        }
      }
    });

    const chats = Array.from(chatsMap.values()).sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json({ success: true, chats });
  } catch (error) {
    console.error('❌ Dashboard chats error:', error);
    res.status(500).json({ error: 'Failed to load chats.' });
  }
});

//  DASHBOARD: Get recent chat history (last 20 messages)
app.get('/api/dashboard/chat-history', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ 
      where: { userId: req.user.userId },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 20
        }
      }
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    res.json({ success: true, messages: tenant.messages });
  } catch (error) {
    console.error(' Chat history error:', error);
    res.status(500).json({ error: 'Failed to load chat history.' });
  }
});

// 🚀 DASHBOARD: Get chat history for a SPECIFIC phone number
app.get('/api/dashboard/chat-history/:number', authenticateToken, async (req, res) => {
  try {
    const { number } = req.params;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Fetch messages between the tenant and this specific number
    const messages = await prisma.message.findMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { fromNumber: number, toNumber: tenant.whatsappNumber },
          { fromNumber: tenant.whatsappNumber, toNumber: number }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: 50
    });

    res.json({ success: true, messages });
  } catch (error) {
    console.error('Chat history error:', error);
    res.status(500).json({ error: 'Failed to load chat history.' });
  }
});

// 🚀 CONNECT WHATSAPP: Show QR Code page
app.get('/connect/:number', authenticateToken, async (req, res) => {
  try {
    const { number } = req.params;
    const tenant = await prisma.tenant.findFirst({ 
      where: { 
        whatsappNumber: number,
        userId: req.user.userId 
      } 
    });
    
    if (!tenant) {
      return res.status(404).send('Tenant not found');
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Connect WhatsApp - ${tenant.businessName}</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-md p-8 text-center">
          <div class="mb-6">
            <h1 class="text-2xl font-bold text-gray-900 mb-2">🔗 Connect WhatsApp</h1>
            <p class="text-gray-600 font-semibold">${tenant.businessName}</p>
            <p class="text-sm text-gray-500 mt-1">Number: ${number}</p>
          </div>
          
          <div id="qrContainer" class="mb-6 p-6 bg-gray-50 rounded-xl border-2 border-dashed border-gray-300 min-h-[250px] flex items-center justify-center">
            <div class="animate-pulse text-center">
              <div class="h-48 w-48 bg-gray-200 rounded-lg mb-4 mx-auto"></div>
              <p class="text-gray-600">⏳ Generating QR code...</p>
            </div>
          </div>
          
          <div id="statusContainer" class="mb-6">
            <p class="text-sm text-gray-600 font-medium">📲 Open WhatsApp on your phone:</p>
            <ol class="text-sm text-gray-500 mt-2 text-left space-y-1 list-decimal list-inside">
              <li>Go to <strong>Settings</strong> → <strong>Linked Devices</strong></li>
              <li>Tap <strong>"Link a Device"</strong></li>
              <li>Scan the QR code above</li>
            </ol>
          </div>
          
          <a href="/dashboard" class="block w-full bg-gray-100 text-gray-700 py-3 rounded-lg font-semibold hover:bg-gray-200 transition">
            ← Back to Dashboard
          </a>
        </div>

        <script>
          async function checkQR() {
            try {
              const res = await fetch('/api/whatsapp/qr/${number}', {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
              });
              const data = await res.json();
              
              if (res.ok) {
                if (data.qrCode) {
                  document.getElementById('qrContainer').innerHTML = \`
                    <img src="\${data.qrCode}" alt="QR Code" class="w-48 h-48 mx-auto mb-4 rounded-lg shadow-sm">
                    <p class="text-green-600 font-semibold">✅ Scan this QR code!</p>
                  \`;
                } else if (data.connected) {
                  document.getElementById('qrContainer').innerHTML = \`
                    <div class="text-green-500 text-6xl mb-4">✅</div>
                    <p class="text-green-600 font-bold text-lg">WhatsApp Connected!</p>
                    <p class="text-gray-600 mt-2">Redirecting to dashboard...</p>
                  \`;
                  setTimeout(() => { window.location.href = '/dashboard'; }, 2000);
                }
              }
            } catch (err) {
              console.error('QR check error:', err);
            }
          }
          
          checkQR();
          setInterval(checkQR, 2000); // Check every 2 seconds
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ Connect page error:', error);
    res.status(500).send('Server error');
  }
});

// 🚀 API: Get QR Code
app.get('/api/whatsapp/qr/:number', authenticateToken, async (req, res) => {
  try {
    const { number } = req.params;
    
    // Check if already connected
    const sock = activeSockets.get(number);
    if (sock && sock.user) {
      return res.json({ connected: true, message: 'Already connected' });
    }
    
    // Get QR code from memory
    const qrCode = qrCodes.get(number);
    if (qrCode) {
      return res.json({ qrCode, connected: false });
    }
    
    res.json({ qrCode: null, connected: false, message: 'Generating QR code...' });
  } catch (error) {
    console.error('❌ QR API error:', error);
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

// 🚀 LIST ALL KNOWLEDGE DOCUMENTS
app.get('/api/dashboard/knowledge', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const documents = await prisma.knowledgeDocument.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, documents });
  } catch (error) {
    console.error('❌ List knowledge error:', error);
    res.status(500).json({ error: 'Failed to load documents.' });
  }
});

// 🚀 DELETE A KNOWLEDGE DOCUMENT
app.delete('/api/dashboard/knowledge/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Ensure the document belongs to this tenant
    const doc = await prisma.knowledgeDocument.findFirst({ where: { id, tenantId: tenant.id } });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    await prisma.knowledgeDocument.delete({ where: { id } });

    res.json({ success: true, message: '✅ Document deleted successfully.' });
  } catch (error) {
    console.error('❌ Delete knowledge error:', error);
    res.status(500).json({ error: 'Failed to delete document.' });
  }
});

// ============================================
// 👨‍💼 AGENT MANAGEMENT ROUTES
// ============================================

// List all agents for tenant
app.get('/api/dashboard/agents', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const agents = await prisma.agent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, agents });
  } catch (error) {
    console.error('❌ List agents error:', error);
    res.status(500).json({ error: 'Failed to load agents.' });
  }
});

// ============================================
// 👨‍💼 CREATE AGENT & SEND INVITATION EMAIL
// ============================================
// Create agent & send invitation (handle existing invitations)
app.post('/api/dashboard/agents', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const { name, email, whatsappNumber, languages } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and Email are required.' });

    // 1. Delete any existing pending invitations for this email
    await prisma.teamInvitation.deleteMany({
      where: {
        email: email,
        tenantId: tenant.id,
        accepted: false
      }
    });

    // 2. Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    
    if (existingUser) {
      // User exists - just add them as team member if not already
      const existingMember = await prisma.teamMember.findFirst({
        where: { tenantId: tenant.id, userId: existingUser.id }
      });

      if (!existingMember) {
        await prisma.teamMember.create({
          data: { tenantId: tenant.id, userId: existingUser.id, role: 'AGENT' }
        });
      }

      // Create agent record
      const agent = await prisma.agent.create({
        data: {
          tenantId: tenant.id,
          name,
          email,
          whatsappNumber: whatsappNumber || null,
          languages: JSON.stringify(languages || ['English']),
          isAvailable: false, // Start as unavailable until they login
          isBusy: false
        }
      });

      return res.json({ 
        success: true, 
        agent, 
        message: `✅ ${name} added as agent (existing user)! They can login immediately.` 
      });
    }

    // 3. New user - create invitation
    const crypto = require('crypto');
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.teamInvitation.create({
      data: {
        email,
        tenantId: tenant.id,
        token: inviteToken,
        expiresAt,
        accepted: false
      }
    });

    // Create agent record (but mark as pending)
    const agent = await prisma.agent.create({
      data: {
        tenantId: tenant.id,
        name,
        email,
        whatsappNumber: whatsappNumber || null,
        languages: JSON.stringify(languages || ['English']),
        isAvailable: false, // Not available until they accept
        isBusy: false
      }
    });

    // 4. Send invitation email with login info
    try {
      const nodemailer = require('nodemailer');
      
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.hostinger.com',
        port: parseInt(process.env.SMTP_PORT || '465'),
        secure: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      const inviteLink = `https://bot.aamirsaba.com/accept-invitation.html?email=${encodeURIComponent(email)}&token=${inviteToken}`;
      const loginLink = `https://bot.aamirsaba.com/login`;

      await transporter.sendMail({
        from: `"${tenant.businessName}" <${process.env.SMTP_USER}>`,
        to: email,
        subject: `You're invited to join ${tenant.businessName} as an Agent!`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #10b981; margin-top: 0;">Welcome to ${tenant.businessName}!</h2>
            <p>You have been invited to join the team as an AI Agent.</p>
            
            <div style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #374151;">Next Steps:</h3>
              <ol style="color: #4b5563;">
                <li>Click the button below to accept the invitation</li>
                <li>Set up your password</li>
                <li>Login to your Agent Dashboard</li>
              </ol>
            </div>
            
            <a href="${inviteLink}" style="display: inline-block; background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 10px 0;">Accept Invitation</a>
            
            <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              <p style="color: #6b7280; font-size: 14px;">After accepting, you can login at:</p>
              <a href="${loginLink}" style="color: #10b981; font-weight: bold;">${loginLink}</a>
            </div>
            
            <p style="color: #6b7280; font-size: 12px; margin-top: 30px;">This link will expire in 7 days. If you did not expect this invitation, please ignore this email.</p>
          </div>
        `
      });
      console.log(`✅ Invitation email sent to ${email}`);
    } catch (emailError) {
      console.error('❌ Failed to send invitation email:', emailError);
    }

    res.json({ success: true, agent, message: `✅ Agent "${name}" added and invitation sent!` });
  } catch (error) {
    console.error('❌ Create agent error:', error);
    res.status(500).json({ error: 'Failed to create agent.' });
  }
});

// ==========================================
// 🚨 AGENT: LOG STATUS CHANGE
// ==========================================
app.post('/api/agent/log-status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body; // "AVAILABLE", "BUSY", "OFFLINE"
    const agent = await prisma.agent.findFirst({ where: { email: req.user.email } });
    
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    // Close previous status log
    await prisma.agentStatusLog.updateMany({
      where: { 
        agentId: agent.id, 
        endTime: null 
      },
      data: { 
        endTime: new Date()
      }
    });

    // Create new status log
    await prisma.agentStatusLog.create({
      data: {
        agentId: agent.id,
        status: status.toUpperCase(),
        startTime: new Date()
      }
    });

    res.json({ success: true, message: 'Status logged' });
  } catch (error) {
    console.error('Log status error:', error);
    res.status(500).json({ error: 'Failed to log status.' });
  }
});

// ==========================================
// 🚨 AGENT: GET KPI REPORT (Admin)
// ==========================================
app.get('/api/dashboard/agents/:id/kpi', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const agent = await prisma.agent.findFirst({ where: { id, tenantId: tenant.id } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    // Get last 7 days of status logs
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const statusLogs = await prisma.agentStatusLog.findMany({
      where: {
        agentId: agent.id,
        startTime: { gte: sevenDaysAgo }
      },
      orderBy: { startTime: 'desc' }
    });

    // Calculate KPIs
    const totalAvailableTime = statusLogs
      .filter(log => log.status === 'AVAILABLE' && log.duration)
      .reduce((sum, log) => sum + log.duration, 0);

    const totalBusyTime = statusLogs
      .filter(log => log.status === 'BUSY' && log.duration)
      .reduce((sum, log) => sum + log.duration, 0);

    // Get conversation stats
    const conversations = await prisma.conversation.count({
      where: { assignedAgentId: agent.id }
    });

    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email
      },
      kpi: {
        totalAvailableHours: (totalAvailableTime / 3600).toFixed(2),
        totalBusyHours: (totalBusyTime / 3600).toFixed(2),
        totalConversations: conversations,
        statusChanges: statusLogs.length
      },
      logs: statusLogs.slice(0, 50)
    });
  } catch (error) {
    console.error('KPI error:', error);
    res.status(500).json({ error: 'Failed to get KPI data.' });
  }
});

// ==========================================
// 🚨 AGENT: GET MY INFO (for agent dashboard)
// ==========================================
app.get('/api/agent/info', authenticateToken, async (req, res) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { email: req.user.email },
      include: {
        tenant: {
          select: {
            businessName: true,
            whatsappNumber: true
          }
        }
      }
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found. Please contact your admin.' });
    }

    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        isAvailable: agent.isAvailable,
        isBusy: agent.isBusy,
        preferredLanguage: agent.preferredLanguage || 'English'
      },
      team: agent.tenant ? {
        businessName: agent.tenant.businessName,
        whatsappNumber: agent.tenant.whatsappNumber
      } : null
    });
  } catch (error) {
    console.error('Agent info error:', error);
    res.status(500).json({ error: 'Failed to load agent info.' });
  }
});

// ==========================================
// 🚨 AGENT: Update agent status (for agents themselves)
// ==========================================
app.put('/api/dashboard/agents/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { isAvailable, isBusy } = req.body;

    // Find the agent by ID
    const agent = await prisma.agent.findUnique({
      where: { id }
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found.' });
    }

    // Security check: Only allow agents to update their own status
    // OR allow tenant admins to update their agents' status
    if (req.user.role === 'AGENT') {
      // Agent updating their own status
      if (agent.email !== req.user.email) {
        return res.status(403).json({ error: 'You can only update your own status.' });
      }
    } else if (req.user.role === 'TENANT' || req.user.role === 'ADMIN') {
      // Admin updating an agent's status - verify they belong to this tenant
      const tenant = await prisma.tenant.findFirst({
        where: { userId: req.user.userId }
      });
      
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found.' });
      }
      
      if (agent.tenantId !== tenant.id) {
        return res.status(403).json({ error: 'This agent does not belong to your team.' });
      }
    } else {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    // Update the agent status
    const updatedAgent = await prisma.agent.update({
      where: { id },
      data: {
        isAvailable: isAvailable !== undefined ? isAvailable : agent.isAvailable,
        isBusy: isBusy !== undefined ? isBusy : agent.isBusy
      }
    });

    res.json({ 
      success: true, 
      message: 'Agent status updated successfully.',
      agent: updatedAgent 
    });
  } catch (error) {
    console.error('Update agent status error:', error);
    res.status(500).json({ error: 'Failed to update agent status.' });
  }
});

// Delete agent (with proper cleanup)
app.delete('/api/dashboard/agents/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Get the agent to find their email
    const agent = await prisma.agent.findFirst({ where: { id, tenantId: tenant.id } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    // 1. Delete all pending invitations for this agent's email
    await prisma.teamInvitation.deleteMany({
      where: {
        email: agent.email,
        tenantId: tenant.id,
        accepted: false
      }
    });

    // 2. Delete the agent record
    await prisma.agent.delete({ where: { id } });

    // 3. Delete team member record (but preserve chat history via cascade)
    // Note: Conversations and messages are preserved via soft delete or cascade
    await prisma.teamMember.deleteMany({
      where: {
        tenantId: tenant.id,
        userId: {
          in: await prisma.user.findMany({
            where: { email: agent.email },
            select: { id: true }
          }).then(users => users.map(u => u.id))
        }
      }
    });

    res.json({ success: true, message: '✅ Agent deleted and all related records cleaned up.' });
  } catch (error) {
    console.error('❌ Delete agent error:', error);
    res.status(500).json({ error: 'Failed to delete agent.' });
  }
});



// ============================================
// 💬 CONVERSATION MANAGEMENT ROUTES
// ============================================

// List all conversations for tenant
app.get('/api/dashboard/conversations', authenticateToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const conversations = await prisma.conversation.findMany({
      where: { tenantId: tenant.id },
      include: { assignedAgent: true },
      orderBy: { lastMessageAt: 'desc' }
    });

    res.json({ success: true, conversations });
  } catch (error) {
    console.error('❌ List conversations error:', error);
    res.status(500).json({ error: 'Failed to load conversations.' });
  }
});

// Switch conversation mode (AI ↔ HUMAN)
app.put('/api/dashboard/conversations/:id/mode', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { mode, agentId } = req.body;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const conversation = await prisma.conversation.findFirst({ 
      where: { id, tenantId: tenant.id } 
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        mode: mode || conversation.mode,
        assignedAgentId: agentId !== undefined ? agentId : conversation.assignedAgentId
      },
      include: { assignedAgent: true }
    });

    res.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('❌ Update conversation mode error:', error);
    res.status(500).json({ error: 'Failed to update conversation.' });
  }
});

// Delete conversation
app.delete('/api/dashboard/conversations/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    await prisma.conversation.delete({ where: { id, tenantId: tenant.id } });
    res.json({ success: true, message: '✅ Conversation deleted.' });
  } catch (error) {
    console.error('❌ Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

// 🚨 MULTER ERROR HANDLER (Catches "File too large" before it crashes)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large. Please upload a PDF or TXT file under 50MB.' });
    }
  }
  next(err);
});


// ==========================================
// 💳 BILLING & SUBSCRIPTION ROUTES
// ==========================================

// 1. Request Manual Bank Transfer Upgrade
app.post('/api/billing/request-upgrade', authenticateToken, async (req, res) => {
  try {
    const { plan, paymentMethod, transactionReference } = req.body;
    const tenant = await prisma.tenant.findFirst({ where: { userId: req.user.userId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Define plan limits
    const planLimits = {
      'starter': { tokens: 150000, limit: 5 },
      'growth': { tokens: 300000, limit: 15 },
      'business': { tokens: 500000, limit: 30 }
    };

    const limits = planLimits[plan];
    if (!limits) return res.status(400).json({ error: 'Invalid plan selected.' });

    // Update tenant to "pending" status
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        plan: plan,
        subscriptionStatus: 'pending_payment',
        paymentMethod: paymentMethod || 'bank_transfer',
        tokenLimit: limits.tokens,
        // Note: We don't add tokens yet. The Super Admin will do this after verifying the bank transfer.
      }
    });

    // Create an alert for the Super Admin
    await prisma.alert.create({
      data: {
        type: 'info',
        title: 'Manual Payment Request',
        message: `${tenant.businessName} requested upgrade to ${plan.toUpperCase()} plan via ${paymentMethod}. Ref: ${transactionReference || 'N/A'}`,
        tenantId: tenant.id
      }
    });

    res.json({ 
      success: true, 
      message: 'Upgrade request submitted! Our team will verify your payment and activate your plan shortly.' 
    });
  } catch (error) {
    console.error('Billing upgrade error:', error);
    res.status(500).json({ error: 'Failed to process upgrade request.' });
  }
});

// 2. Super Admin: Approve Manual Payment & Add Tokens
app.post('/api/admin/billing/approve-payment', authenticateSuperAdmin, async (req, res) => {
  try {
    const { tenantId, plan } = req.body;
    
    const planLimits = {
      'starter': 150000,
      'growth': 300000,
      'business': 500000
    };

    const tokensToAdd = planLimits[plan] || 150000;
    const nextBillingDate = new Date();
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

    const updatedTenant = await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionStatus: 'active',
        tokenBalance: { increment: tokensToAdd },
        currentPeriodEnd: nextBillingDate,
        lowTokenWarningSent: false // Reset warning flag
      }
    });

    // Notify tenant (optional: send WhatsApp or email here)
    await prisma.alert.create({
      data: {
        type: 'success',
        title: 'Payment Approved',
        message: `Your ${plan.toUpperCase()} plan has been activated! ${tokensToAdd.toLocaleString()} tokens added.`,
        tenantId: tenantId
      }
    });

    res.json({ success: true, message: 'Payment approved and tokens added successfully.' });
  } catch (error) {
    console.error('Approve payment error:', error);
    res.status(500).json({ error: 'Failed to approve payment.' });
  }
});

// 🚨 AUTO-EXPIRE TRIALS EVERY HOUR
cron.schedule('0 * * * *', async () => {
  try {
    console.log('⏰ Checking for expired trials...');
    
    const now = new Date();
    const expiredTrials = await prisma.tenant.findMany({
      where: {
        plan: 'trial',
        trialEndsAt: { lte: now },
        isSuspended: false
      }
    });

    for (const tenant of expiredTrials) {
      console.log(`🚫 Trial expired for ${tenant.businessName}. Suspending...`);
      
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { isSuspended: true, subscriptionStatus: 'cancelled' }
      });

      // Notify tenant
      await prisma.alert.create({
        data: {
          type: 'warning',
          title: 'Trial Expired',
          message: 'Your free trial has ended. Please upgrade to continue using the service.',
          tenantId: tenant.id
        }
      });
    }

    if (expiredTrials.length > 0) {
      console.log(`✅ Suspended ${expiredTrials.length} expired trial accounts.`);
    }
  } catch (error) {
    console.error('❌ Trial expiration check failed:', error);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp AI SaaS Backend is running!`);
  console.log(`🌐 Server running on http://localhost:${PORT}`);
  
  // 🚀 CALL THE AUTO-START FUNCTION HERE
  startAllActiveSessions();
  // 🚀 AUTOMATED DAILY BRIEF CRON JOB
  // Runs every minute to check if any tenant needs a summary right now
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Format current time as "HH:MM" (e.g., "21:05")
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      
      // Find tenants who want a summary at this exact minute
      const tenantsToNotify = await prisma.tenant.findMany({
        where: {
          isSummaryEnabled: true,
          summaryTime: currentTime,
          isActive: true // Only send if WhatsApp is connected
        }
      });

      if (tenantsToNotify.length > 0) {
        console.log(`⏰ Cron Job: Sending daily briefs to ${tenantsToNotify.length} tenant(s) at ${currentTime}`);
        
        for (const tenant of tenantsToNotify) {
          try {
            // 1. Get today's messages
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            
            const todaysMessages = await prisma.message.findMany({
              where: { tenantId: tenant.id, createdAt: { gte: startOfDay } },
              orderBy: { createdAt: 'asc' }
            });

            if (todaysMessages.length === 0) continue; // Skip if no messages

            // 2. Format and generate AI summary
            const chatLog = todaysMessages.map(m => `[${m.direction === 'inbound' ? 'Customer' : 'AI'}] ${m.fromNumber}: ${m.content}`).join('\n');
            const systemPrompt = "Summarize this daily WhatsApp chat log into a brief, professional daily brief. Highlight: 1. Total interactions. 2. Key lead inquiries. 3. Unresolved issues. Use bullet points.";
            const { getAIResponse } = require('./ai');
            const summary = await getAIResponse(chatLog, systemPrompt, tenant);

            // 3. Send to WhatsApp "Message Yourself"
            const sock = activeSockets.get(tenant.whatsappNumber);
            if (sock) {
              const selfJid = `${tenant.whatsappNumber}@s.whatsapp.net`;
              await sock.sendMessage(selfJid, { text: `📊 *Daily AI Summary for ${tenant.businessName}*\n\n${summary}` });
              console.log(`✅ Sent automated brief to ${tenant.businessName}`);
            }
          } catch (err) {
            console.error(`❌ Failed to send brief to ${tenant.businessName}:`, err.message);
          }
        }
      }
    } catch (error) {
      console.error('❌ Cron job error:', error);
    }
  });
 
});

