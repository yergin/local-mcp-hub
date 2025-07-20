const express = require('express');
const cors = require('cors');

const app = express();
const port = 3002; // Same port as the hub

// Middleware
app.use(cors());
app.use(express.json());

// OpenAI-compatible chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log(`📥 Request received at ${new Date().toISOString()}`);
    
    const { messages, model } = req.body;
    const userMessage = messages[messages.length - 1]?.content || '';
    
    // Extract delay from the user message (expecting a number in seconds)
    const delaySeconds = parseInt(userMessage.trim()) || 5;
    const delayMs = delaySeconds * 1000;
    
    console.log(`⏰ Will respond after ${delaySeconds} seconds (${delayMs}ms)`);
    console.log(`📝 User message: "${userMessage}"`);
    console.log(`🤖 Request model: "${model}"`);
    
    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    console.log(`📤 Sending response after ${delaySeconds}s delay`);
    
    // Send OpenAI-compatible response with SAME model as request
    const response = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'qwen2.5:latest',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `Response sent after ${delaySeconds} seconds delay. Current time: ${new Date().toISOString()}`
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      }
    };
    
    console.log(`📋 EXACT RESPONSE BEING SENT TO CONTINUE:`);
    console.log(JSON.stringify(response, null, 2));
    console.log(`📏 Response size: ${JSON.stringify(response).length} bytes`);
    console.log(`📊 Headers being sent: ${JSON.stringify(res.getHeaders())}`);
    
    res.json(response);
    console.log(`✅ Response sent successfully at ${new Date().toISOString()}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Test timeout server running on port ${port}`);
  console.log(`📋 Health check: http://localhost:${port}/health`);
  console.log(`🎯 OpenAI API: http://localhost:${port}/v1`);
  console.log(`\n📖 Usage: Send a chat completion request with a number as the message.`);
  console.log(`   The server will delay that many seconds before responding.`);
  console.log(`   Example: "30" = 30 second delay, "5" = 5 second delay\n`);
});