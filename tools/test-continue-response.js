const http = require('http');

async function testHubResponse() {
  console.log('🧪 Testing hub response to Continue-style request...');
  
  const requestData = JSON.stringify({
    model: "qwen2.5:latest",
    messages: [{"role": "user", "content": "What files are in this directory?"}],
    tools: [{"type": "function", "function": {"name": "dummy_tool", "description": "A dummy tool"}}]
  });

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    console.log(`📤 Sending request at ${new Date().toISOString()}`);
    
    const options = {
      hostname: 'localhost',
      port: 3002,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    const req = http.request(options, (res) => {
      console.log(`📥 Response started - Status: ${res.statusCode}`);
      console.log(`📋 Headers:`, res.headers);
      
      let data = '';
      let chunkCount = 0;
      
      res.on('data', (chunk) => {
        chunkCount++;
        data += chunk;
        console.log(`📦 Chunk ${chunkCount} received (${chunk.length} bytes) at ${Date.now() - startTime}ms`);
      });

      res.on('end', () => {
        const totalTime = Date.now() - startTime;
        console.log(`✅ Response complete after ${totalTime}ms`);
        console.log(`📏 Total response length: ${data.length} bytes`);
        
        try {
          const parsed = JSON.parse(data);
          console.log('✅ JSON parse successful');
          console.log(`📝 Response content: ${parsed.choices[0].message.content.substring(0, 200)}...`);
          resolve(parsed);
        } catch (e) {
          console.log('❌ JSON parse failed:', e.message);
          console.log('🔍 Raw response:', data.substring(0, 500));
          reject(e);
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Request error:', error);
      reject(error);
    });

    req.on('timeout', () => {
      console.error('⏰ Request timeout');
      req.destroy();
      reject(new Error('Request timeout'));
    });

    // Set a reasonable timeout
    req.setTimeout(120000); // 2 minutes

    req.write(requestData);
    req.end();
    
    console.log(`📨 Request sent, waiting for response...`);
  });
}

// Run the test
testHubResponse()
  .then(response => {
    console.log('🎉 Test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Test failed:', error.message);
    process.exit(1);
  });