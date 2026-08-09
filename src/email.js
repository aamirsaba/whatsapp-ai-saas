const nodemailer = require('nodemailer');

// Configure the transporter using Hostinger SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT == 465, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendWelcomeEmail(userEmail, businessName) {
  const mailOptions = {
    from: `"WhatsApp AI SaaS" <${process.env.SMTP_USER}>`,
    to: userEmail,
    subject: '🚀 Welcome to WhatsApp AI SaaS!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #16a34a;">Welcome to WhatsApp AI SaaS!</h2>
        <p>Hello,</p>
        <p>Thank you for registering <strong>${businessName}</strong> with our platform. Your AI-powered WhatsApp assistant is now being set up.</p>
        <p>Here are your next steps:</p>
        <ol style="line-height: 1.6;">
          <li>Log in to your dashboard at <a href="https://bot.aamirsaba.com/login" style="color: #16a34a;">bot.aamirsaba.com</a></li>
          <li>Scan the QR code to link your WhatsApp business number.</li>
          <li>Customize your AI's personality and business context in the settings.</li>
        </ol>
        <p>If you have any questions, simply reply to this email or contact us at <a href="mailto:info@aamirsaba.com">info@aamirsaba.com</a>.</p>
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
    // We don't throw the error here, so registration still succeeds even if email fails
  }
}

module.exports = { sendWelcomeEmail };