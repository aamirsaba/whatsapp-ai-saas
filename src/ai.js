const axios = require('axios');

async function getAIResponse(userMessage, systemPrompt) {
  try {
    const response = await axios.post(
      process.env.QWEN_API_URL,
      {
        model: "qwen-plus", // You can also use "qwen-turbo" or "qwen-max"
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7, // Balanced creativity and accuracy
        max_tokens: 300   // Keep replies concise for WhatsApp
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.QWEN_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Qwen API Error:", error.response?.data || error.message);
    return "عذراً، حدث خطأ مؤقت. يرجى المحاولة لاحقاً. (Sorry, a temporary error occurred. Please try again later.)";
  }
}

module.exports = { getAIResponse };