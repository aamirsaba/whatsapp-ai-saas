const crypto = require('crypto'); // 🚨 ADDED: For auto-generating passwords
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
// 🚨 UPDATED: Import BOTH email functions
const { sendWelcomeEmail, sendAdminNotificationEmail } = require('./email'); 

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

// 🚀 REGISTER A NEW USER
async function registerUser(email, password, businessName, whatsappNumber, businessContext) {
  // 1. 🚨 CRITICAL FIX: Always remove '+', spaces, or dashes before saving
  const cleanNumber = whatsappNumber.replace(/\D/g, '');

  // 2. Check if user already exists
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) throw new Error('Email already registered');

  // 3. 🚨 NEW: Auto-generate password if not provided by frontend
  const generatedPassword = password || crypto.randomBytes(10).toString('hex');
  const hashedPassword = await bcrypt.hash(generatedPassword, 10);

  // 4. Create User and Tenant in a single transaction
  const result = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: { email, password: hashedPassword, role: 'TENANT' }
    });

    const newTenant = await tx.tenant.create({
      data: {
        businessName,
        whatsappNumber: cleanNumber, 
        systemPrompt: 'You are a helpful, professional AI assistant for this business.',
        businessContext: businessContext,
        userId: newUser.id
      }
    });

    return { user: newUser, tenant: newTenant };
  });

  // 5. Generate JWT Token
  const token = jwt.sign({ userId: result.user.id, role: result.user.role }, JWT_SECRET, { expiresIn: '7d' });

  // 6. 🚀 SEND EMAILS (User Welcome + Admin Notification)
  sendWelcomeEmail(email, businessName, generatedPassword); // Pass the generated password!
  sendAdminNotificationEmail(email, businessName, cleanNumber); // Notify the admin

  return { 
    token, 
    user: { id: result.user.id, email: result.user.email, role: result.user.role }, 
    tenant: result.tenant 
  };
}

// Inside src/auth.js (or wherever loginUser is defined)
async function loginUser(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('User not found.');

  const bcrypt = require('bcryptjs');
  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throw new Error('Invalid password.');

  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET || 'your-secret-key-change-this',
    { expiresIn: '7d' }
  );

  // 🚨 MAKE SURE THIS IS RETURNED
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      requiresPasswordChange: user.requiresPasswordChange || false // 🚨 CRITICAL
    },
    tenant: await prisma.tenant.findFirst({ where: { userId: user.id } })
  };
}

module.exports = { registerUser, loginUser };