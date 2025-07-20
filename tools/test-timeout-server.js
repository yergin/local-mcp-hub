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
    
    const { messages, model, stream } = req.body;
    const userMessage = messages[messages.length - 1]?.content || '';
    
    // Extract delay from the user message (expecting a number in seconds)
    const delaySeconds = parseInt(userMessage.trim()) || 5;
    const delayMs = delaySeconds * 1000;
    
    console.log(`⏰ Will respond after ${delaySeconds} seconds (${delayMs}ms)`);
    console.log(`📝 User message: "${userMessage}"`);
    console.log(`🤖 Request model: "${model}"`);
    console.log(`🌊 Stream requested: ${stream}`);
    
    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    console.log(`📤 Sending response after ${delaySeconds}s delay`);
    
    if (stream) {
      // Send streaming response (SSE format like the hub)
      console.log(`🌊 Sending STREAMING response`);
      
      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      });

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const responseText = `Response sent after ${delaySeconds} seconds delay. Current time: ${new Date().toISOString()}`;
      
      console.log(`📋 STREAMING RESPONSE HEADERS:`, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      });
      
      // Split response into chunks like the hub does
      const words = responseText.split(' ');
      
      console.log(`🔄 Sending ${words.length} chunks...`);
      
      for (let i = 0; i < words.length; i++) {
        const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
        
        const streamChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: model || 'qwen2.5:latest',
          choices: [{
            index: 0,
            delta: { content: chunk },
            finish_reason: null
          }]
        };
        
        const chunkData = `data: ${JSON.stringify(streamChunk)}\n\n`;
        console.log(`📦 Chunk ${i}: ${chunkData.trim()}`);
        res.write(chunkData);
        
        // Small delay between chunks
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Send final chunk
      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: model || 'qwen2.5:latest',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: words.length,
          total_tokens: 10 + words.length
        }
      };
      
      const finalChunkData = `data: ${JSON.stringify(finalChunk)}\n\n`;
      const doneData = 'data: [DONE]\n\n';
      
      console.log(`✅ Final chunk: ${finalChunkData.trim()}`);
      console.log(`🏁 Done message: ${doneData.trim()}`);
      
      res.write(finalChunkData);
      res.write(doneData);
      res.end();
      
    } else {
      // Send non-streaming response
      console.log(`📄 Sending NON-STREAMING response`);
      
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
    }
    
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