const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function createSuperAdmin() {
  // 🚨 CHANGE THESE to your desired admin credentials
  const email = 'aamir.durrani2011@gmail.com'; 
  const password = 'SuperAdmin123!'; 
  
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    // Check if user already exists
    let user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      // Update existing user to ADMIN role
      user = await prisma.user.update({
        where: { id: user.id },
        data: { 
          role: 'ADMIN',
          password: hashedPassword,
          requiresPasswordChange: false
        }
      });
      console.log(`✅ Updated existing user "${email}" to SUPER ADMIN.`);
    } else {
      // Create a brand new ADMIN user
      user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          role: 'ADMIN',
          requiresPasswordChange: false
        }
      });
      console.log(`✅ Created new SUPER ADMIN user: "${email}"`);
    }

    console.log('\n🎉 SUCCESS! You can now log in with:');
    console.log(`🔑 Email:    ${email}`);
    console.log(`🔑 Password: ${password}`);
    console.log(`🌐 URL:      http://localhost:3000/login\n`);

  } catch (error) {
    console.error('❌ Failed to create/update admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createSuperAdmin();