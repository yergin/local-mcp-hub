const http = require('http');

// Simulate a Continue agent mode request with tools
const continueRequest = {
  model: 'qwen2.5:latest',
  messages: [
    {
      role: 'user',
      content: 'What files are in this directory?'
    }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'dummy_tool',
        description: 'A dummy tool from Continue',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    }
  ],
  temperature: 0.7,
  max_tokens: 4000,
  stream: false
};

const postData = JSON.stringify(continueRequest);

const options = {
  hostname: 'localhost',
  port: 3002,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('Sending Continue-style request to hub...');
console.log('Request:', JSON.stringify(continueRequest, null, 2));

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('\nResponse:', JSON.stringify(response, null, 2));
    } catch (e) {
      console.log('\nRaw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('Request failed:', error.message);
});

req.write(postData);
req.end();