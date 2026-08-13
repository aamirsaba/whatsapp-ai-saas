/**
 * Unified AI Router with Timeout and Detailed Error Logging
 * Note: Language mirroring, service zones, and industry personas 
 * are dynamically injected via the 'systemPrompt' parameter.
 */
async function getAIResponse(userMessage, systemPrompt, tenant) {
  try {
    // 1. Strict check for API Key
    if (!tenant || !tenant.llmApiKey) {
      throw new Error("Tenant LLM API Key is missing. Please add it in the dashboard.");
    }

    const apiKey = tenant.llmApiKey;
    const model = tenant.llmModel || 'gpt-3.5-turbo';
    
    let baseUrl = tenant.llmBaseUrl;
    if (!baseUrl) {
      if (tenant.llmProvider === 'QWEN') {
        baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
      } else {
        baseUrl = 'https://api.openai.com/v1';
      }
    }

    const apiUrl = `${baseUrl}/chat/completions`;
    console.log(`🧠 Calling AI: ${tenant.llmProvider} | Model: ${model}`);

    // 2. Add a 15-second timeout to prevent silent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 800 // 🚨 INCREASED: Prevents cut-offs during detailed sales/contact replies
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 3. Detailed error logging if the API key is invalid or quota is exceeded
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API Error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();

  } catch (error) {
    console.error('❌ AI Generation Failed:', error.message);
    return "I'm sorry, I'm having trouble connecting to my brain. Please check the LLM API Key in your dashboard settings or try again in a moment.";
  }
}

module.exports = { getAIResponse };