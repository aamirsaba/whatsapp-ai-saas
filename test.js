const axios = require('axios');

async function triggerConnection() {
  console.log("🚀 Sending connection request to backend...");
  try {
    const response = await axios.post('http://localhost:3000/api/connect', {
      businessName: "My Test Business",
      whatsappNumber: "96891293119" // Use your real WhatsApp number here
    });
    console.log("✅ Success:", response.data);
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
  }
}

triggerConnection();