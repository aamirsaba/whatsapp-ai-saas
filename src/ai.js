
/**
 * Unified AI Router: Checks tenant settings and routes to the correct LLM
 */
async function getAIResponse(userMessage, systemPrompt, tenant = null) {
  try {
    // 1. Determine which API Key and Model to use
    // If tenant has their own key, use it. Otherwise, fall back to server's default Qwen key.
    const apiKey = (tenant && tenant.llmApiKey) ? tenant.llmApiKey : process.env.QWEN_API_KEY;
    const model = (tenant && tenant.llmModel) ? tenant.llmModel : 'qwen-turbo'; // Default fallback model
    const provider = (tenant && tenant.llmProvider) ? tenant.llmProvider : 'QWEN';
    const apiUrl = process.env.QWEN_API_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

    console.log(`🧠 Using AI Provider: ${provider} | Model: ${model}`);

    // 2. Build the messages array for the LLM
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    // 3. Make the API call (Currently formatted for OpenAI-compatible APIs like Qwen, OpenAI, Groq, etc.)
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`AI API Error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();

  } catch (error) {
    console.error('❌ AI Generation Failed:', error.message);
    return "I'm sorry, I'm having trouble connecting to my brain right now. Please try again in a moment.";
  }
}

module.exports = { getAIResponse };