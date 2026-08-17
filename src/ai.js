/**
 * Unified AI Router with Timeout and Detailed Error Logging
 * Note: Language mirroring, service zones, and industry personas 
 * are dynamically injected via the 'systemPrompt' parameter.
 */
async function getAIResponse(chatHistory, systemPrompt, tenant) {
  try {
    // 1. Strict check for API Key
    if (!tenant || !tenant.llmApiKey) {
      throw new Error("Tenant LLM API Key is missing. Please add it in the dashboard.");
    }

    const apiKey = tenant.llmApiKey;
    const model = tenant.llmModel || 'gpt-3.5-turbo';
    
    let baseUrl = tenant.llmBaseUrl;
    
    // 🚨 FIXED: Smart routing based on the EXACT provider name saved in DB
    if (!baseUrl) {
      if (tenant.llmProvider === 'QWEN' || tenant.llmProvider === 'ALIBABA') {
        baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
      } else if (tenant.llmProvider === 'DEEPSEEK') {
        baseUrl = 'https://api.deepseek.com/v1';
      } else if (tenant.llmProvider === 'GROQ') {
        baseUrl = 'https://api.groq.com/openai/v1';
      } else if (tenant.llmProvider === 'ANTHROPIC') {
        baseUrl = 'https://api.anthropic.com/v1';
      } else {
        baseUrl = 'https://api.openai.com/v1'; // Default fallback
      }
    }

    const apiUrl = `${baseUrl}/chat/completions`;
    console.log(`🧠 Calling AI: ${tenant.llmProvider} | Model: ${model} | URL: ${baseUrl}`);

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
          ...chatHistory
        ],
        temperature: 0.1, // 🚨 CHANGED FROM 0.7 TO 0.1 FOR STRICT RULE ADHERENCE
        max_tokens: 800
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

// 🚨 NEW: Translation Function using your existing LLM
async function translateText(text, targetLanguage, llmProvider, llmApiKey, llmModel, llmBaseUrl) {
  if (!text) return text;

  const prompt = `Translate the following text to ${targetLanguage}. Only output the translated text, no explanations.\n\nText: "${text}"`;

  try {
    // We reuse your existing getAIResponse logic but with a simple prompt
    // Note: You might need to adjust this depending on how your ai.js is structured. 
    // For now, we will use a direct fetch to the OpenAI-compatible endpoint which Alibaba supports.
    
    const baseUrl = llmBaseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmApiKey}`
      },
      body: JSON.stringify({
        model: llmModel || 'qwen-plus',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3 // Low temperature for accurate translation
      })
    });

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }
    return text; // Fallback to original if translation fails
  } catch (error) {
    console.error('❌ Translation error:', error);
    return text;
  }
}

module.exports = { getAIResponse, translateText }; // Make sure to add translateText to exports

