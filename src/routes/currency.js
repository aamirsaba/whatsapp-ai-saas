const express = require('express');
const router = express.Router();
const axios = require('axios');

// Cache exchange rates (update every hour)
let exchangeRatesCache = { rates: {}, lastUpdated: null };

//  AUTO-DETECT USER COUNTRY & CURRENCY
router.get('/detect', async (req, res) => {
  try {
    // Get user's IP
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.headers['x-real-ip'] || 
                     req.socket.remoteAddress;

    // Detect country from IP using free API
    const ipResponse = await axios.get(`https://ipapi.co/${clientIP}/json/`);
    const { country_code, currency, currency_name } = ipResponse.data;

    // Fetch latest exchange rates (GBP base)
    const rates = await getExchangeRates();

    res.json({
      success: true,
      country: country_code,
      currency: currency,
      currencyName: currency_name,
      exchangeRate: rates[currency] || 1,
      baseCurrency: 'GBP'
    });

  } catch (error) {
    console.error('Currency detection error:', error.message);
    // Fallback to GBP
    res.json({
      success: true,
      country: 'GB',
      currency: 'GBP',
      currencyName: 'British Pound',
      exchangeRate: 1,
      baseCurrency: 'GBP'
    });
  }
});

// 💱 FETCH LIVE EXCHANGE RATES
async function getExchangeRates() {
  const now = Date.now();
  const cacheAge = exchangeRatesCache.lastUpdated ? now - exchangeRatesCache.lastUpdated : Infinity;

  // Return cached rates if less than 1 hour old
  if (cacheAge < 60 * 60 * 1000 && Object.keys(exchangeRatesCache.rates).length > 0) {
    return exchangeRatesCache.rates;
  }

  try {
    // Use free API (no key required)
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/GBP');
    
    exchangeRatesCache = {
      rates: response.data.rates,
      lastUpdated: now
    };

    return response.data.rates;

  } catch (error) {
    console.error('Failed to fetch exchange rates:', error.message);
    
    // Fallback rates
    exchangeRatesCache = {
      rates: {
        'GBP': 1,
        'USD': 1.27,
        'EUR': 1.17,
        'PKR': 350,
        'AED': 4.66,
        'SAR': 4.76,
        'OMR': 0.49,
        'INR': 106,
        'BDT': 140,
        'EGP': 62,
        'JOD': 0.90,
        'KWD': 0.39,
        'BHD': 0.48,
        'QAR': 4.62,
      },
      lastUpdated: now
    };
    
    return exchangeRatesCache.rates;
  }
}

module.exports = router;