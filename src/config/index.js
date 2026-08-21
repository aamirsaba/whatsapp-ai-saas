require('dotenv').config();

const config = {
  // Environment
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  
  // Database
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  },
  
  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: '30d'
  },
  
  // WhatsApp (Baileys)
  whatsapp: {
    sessionId: process.env.WHATSAPP_SESSION_ID || 'default',
    reconnectInterval: 5000
  },
  
  // AI Provider (Qwen)
  ai: {
    provider: 'QWEN',
    apiKey: process.env.QWEN_API_KEY,
    baseUrl: process.env.QWEN_API_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: process.env.QWEN_MODEL || 'qwen-plus',
    maxTokens: 2000
  },
  
  // Stripe
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    prices: {
      starter: process.env.STRIPE_PRICE_STARTER,
      growth: process.env.STRIPE_PRICE_GROWTH,
      business: process.env.STRIPE_PRICE_BUSINESS
    },
    mode: process.env.NODE_ENV === 'production' ? 'live' : 'test'
  },
  
  // Email (SMTP)
  email: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'noreply@aamirsaba.com'
  },
  
  // Admin Notifications
  admin: {
    whatsappNumber: process.env.ADMIN_WHATSAPP_NUMBER,
    email: process.env.ADMIN_EMAIL,
    discordWebhook: process.env.DISCORD_WEBHOOK_URL
  },
  
  // Application
  app: {
    name: 'Universal AI SaaS',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    apiVersion: 'v1'
  }
};

// Validate required config
const required = ['DATABASE_URL', 'JWT_SECRET', 'QWEN_API_KEY'];
if (config.env === 'production') {
  required.push('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET');
}

required.forEach(key => {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
});

module.exports = config;