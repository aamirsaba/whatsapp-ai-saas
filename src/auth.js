const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

// 🚀 REGISTER A NEW USER
async function registerUser(email, password, businessName, whatsappNumber) {
  // 1. Check if user already exists
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) throw new Error('Email already registered');

  // 2. Hash the password
  const hashedPassword = await bcrypt.hash(password, 10);

  // 3. Create User and Tenant in a single transaction
  const result = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: { email, password: hashedPassword, role: 'TENANT' }
    });

    const newTenant = await tx.tenant.create({
      data: {
        businessName,
        whatsappNumber,
        systemPrompt: 'You are a helpful AI assistant.',
        userId: newUser.id // Link tenant to user
      }
    });

    return { user: newUser, tenant: newTenant };
  });

  // 4. Generate JWT Token
  const token = jwt.sign({ userId: result.user.id, role: result.user.role }, JWT_SECRET, { expiresIn: '7d' });

  return { token, user: { id: result.user.id, email: result.user.email, role: result.user.role }, tenant: result.tenant };
}

// 🚀 LOGIN USER
async function loginUser(email, password) {
  // 1. Find user
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('Invalid email or password');

  // 2. Check password
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) throw new Error('Invalid email or password');

  // 3. Generate JWT Token
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

  // 4. Fetch their tenant info
  const tenant = await prisma.tenant.findFirst({ where: { userId: user.id } });

  return { token, user: { id: user.id, email: user.email, role: user.role }, tenant };
}

module.exports = { registerUser, loginUser };