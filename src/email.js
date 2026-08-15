const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT == 465, 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 1. Welcome Email for the New User (Updated to show password)
async function sendWelcomeEmail(userEmail, businessName, password) {
  const mailOptions = {
    from: `"WhatsApp AI SaaS" <${process.env.SMTP_USER}>`,
    to: userEmail,
    subject: '🚀 Welcome to WhatsApp AI SaaS!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #16a34a;">Welcome to WhatsApp AI SaaS!</h2>
        <p>Hello,</p>
        <p>Thank you for registering <strong>${businessName}</strong> with our platform.</p>
        
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <p style="margin: 0; font-weight: bold; color: #166534;">Your Login Credentials:</p>
          <p style="margin: 5px 0 0 0; font-family: monospace; font-size: 16px; color: #166534;">🔑 Password: <strong>${password}</strong></p>
        </div>

        <p>Please save this password securely. You can change it later in your dashboard.</p>
        
        <p>Here are your next steps:</p>
        <ol style="line-height: 1.6;">
          <li>Log in to your dashboard at <a href="https://bot.aamirsaba.com/login" style="color: #16a34a;">bot.aamirsaba.com</a></li>
          <li>Scan the QR code to link your WhatsApp business number.</li>
          <li>Customize your AI's personality in the settings.</li>
        </ol>
        <br>
        <p style="color: #6b7280; font-size: 14px;">Best regards,<br><strong>The Aamir Saba Team</strong><br>https://aamirsaba.com</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Welcome email sent to ${userEmail}`);
  } catch (error) {
    console.error('❌ Failed to send welcome email:', error.message);
  }
}

// 🚨 ADMIN NOTIFICATION EMAIL
async function sendAdminNotificationEmail(newEmail, nameOrBusiness, whatsappNumber, botType = 'business') {
  // 🚨 FOOLPROOF FALLBACK: Uses .env if available, otherwise defaults to your email
  const adminEmail = process.env.ADMIN_EMAIL || 'aamir@aamirsaba.com'; 
  
  const botTypeEmoji = botType === 'personal' ? '👤 Personal' : '🏢 Business';
  const accountLabel = botType === 'personal' ? 'Personal Account' : 'Business';

  const mailOptions = {
    from: `"WhatsApp AI SaaS System" <${process.env.SMTP_USER}>`,
    to: adminEmail,
    subject: `🔔 New ${accountLabel} Registered!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #f9fafb;">
        <h2 style="color: #16a34a;">🔔 New ${accountLabel} Registered!</h2>
        <p>Hello Admin,</p>
        <p>A new user has just signed up on your platform:</p>
        <ul style="line-height: 1.8; background: #fff; padding: 15px; border-radius: 6px; border: 1px solid #e5e7eb;">
          <li><strong>🤖 Bot Type:</strong> ${botTypeEmoji}</li>
          <li><strong>📧 Email:</strong> ${newEmail}</li>
          <li><strong>👤 Name/Business:</strong> ${nameOrBusiness}</li>
          <li><strong>📱 WhatsApp:</strong> ${whatsappNumber}</li>
        </ul>
        <p>Log in to your dashboard to monitor their activity.</p>
        <br>
        <p style="color: #6b7280; font-size: 14px;">Best regards,<br><strong>Your SaaS System</strong></p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Admin notification email sent to ${adminEmail}`);
  } catch (error) {
    console.error('❌ Failed to send admin notification email:', error.message);
  }
}

// 3. Password Reset Email
async function sendPasswordResetEmail(userEmail, newPassword) {
  const mailOptions = {
    from: `"WhatsApp AI SaaS" <${process.env.SMTP_USER}>`,
    to: userEmail,
    subject: '🔑 Your New Password for WhatsApp AI SaaS',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #16a34a;">Password Reset Request</h2>
        <p>Hello,</p>
        <p>We received a request to reset your password. Your new temporary password is:</p>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin: 20px 0; text-align: center;">
          <p style="margin: 0; font-family: monospace; font-size: 24px; font-weight: bold; color: #166534;">${newPassword}</p>
        </div>
        <p>Please log in with this password and change it immediately in your dashboard settings.</p>
        <br>
        <p style="color: #6b7280; font-size: 14px;">Best regards,<br><strong>The Aamir Saba Team</strong></p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Password reset email sent to ${userEmail}`);
  } catch (error) {
    console.error('❌ Failed to send password reset email:', error.message);
  }
}

// 🚀 AGENT INVITATION EMAIL
async function sendAgentInvitationEmail(email, businessName, inviteLink) {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || 'Universal AI SaaS'}" <${process.env.SMTP_USER}>`,
    to: email,
    subject: ` You've been invited to join ${businessName}'s team!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #f9fafb;">
        <h2 style="color: #16a34a;">🎉 You're Invited!</h2>
        <p>Hello,</p>
        <p>You've been invited to join <strong>${businessName}</strong>'s team as an AI Agent on Universal AI SaaS.</p>
        
        <div style="background: white; padding: 20px; border-radius: 6px; margin: 20px 0; text-align: center;">
          // In sendAgentInvitationEmail, update the button text:
<a href="${inviteLink}" 
   style="display: inline-block; background: #16a34a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
  Accept Invitation & Set Password
</a>
        </div>

        <p style="color: #6b7280; font-size: 14px;">
          This invitation link will expire in 7 days. If you have any questions, please contact the team.
        </p>

        <br>
        <p style="color: #6b7280; font-size: 14px;">Best regards,<br><strong>Universal AI SaaS Team</strong></p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Agent invitation email sent to ${email}`);
  } catch (error) {
    console.error('❌ Failed to send agent invitation email:', error.message);
    throw error;
  }
}

module.exports = { 
  sendWelcomeEmail, 
  sendAdminNotificationEmail, 
  sendPasswordResetEmail,
  sendAgentInvitationEmail  // 🚨 ADD THIS
};