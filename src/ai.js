/**
 * Unified AI Router: Strictly uses Tenant's LLM settings
 */
async function getAIResponse(userMessage, systemPrompt, tenant) {
  try {
    if (!tenant || !tenant.llmApiKey) {
      throw new Error("Tenant LLM API Key is missing.");
    }

    const apiKey = tenant.llmApiKey;
    const model = tenant.llmModel;
    
    // Use the saved Base URL, or fallback to standard endpoints if missing
    let baseUrl = tenant.llmBaseUrl;
    if (!baseUrl) {
      if (tenant.llmProvider === 'QWEN') {
        baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
      } else {
        baseUrl = 'https://api.openai.com/v1'; // Default to OpenAI standard
      }
    }

    const apiUrl = `${baseUrl}/chat/completions`;

    console.log(`🧠 Using AI: ${tenant.llmProvider} | Model: ${model} | URL: ${apiUrl}`);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

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
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`AI API Error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();

  } catch (error) {
    console.error('❌ AI Generation Failed:', error.message);
    return "I'm sorry, I'm having trouble connecting to my brain. Please check the LLM API Key in your dashboard settings.";
  }
}

module.exports = { getAIResponse };