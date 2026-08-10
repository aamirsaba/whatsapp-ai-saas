const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeWebsiteContext(url) {
  try {
    console.log(`🕷️ Scraping website for context: ${url}`);
    
    // Ensure URL has http/https
    const validUrl = url.startsWith('http') ? url : `https://${url}`;
    
    // Fetch the webpage
    const { data } = await axios.get(validUrl, { 
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } // Prevents basic bot blocking
    });

    // Load into Cheerio
    const $ = cheerio.load(data);

    // Remove scripts, styles, and navigation to get clean text
    $('script, style, nav, footer, header, iframe, noscript').remove();

    // Extract text and clean up extra spaces
    const rawText = $('body').text().replace(/\s+/g, ' ').trim();

    // Truncate to ~1500 characters to keep the AI prompt focused and save tokens
    const cleanText = rawText.substring(0, 1500);

    console.log("✅ Successfully scraped website content!");
    return cleanText;

  } catch (error) {
    console.error("❌ Failed to scrape website:", error.message);
    return null;
  }
}

module.exports = { scrapeWebsiteContext };