const { spawn } = require('child_process');
const path = require('path');

console.log('Testing Serena MCP handshake...');

const mcpProcess = spawn(path.join(__dirname, '..', 'mcps', 'serena', '.venv', 'bin', 'python'), [
  path.join(__dirname, '..', 'mcps', 'serena', 'scripts', 'mcp_server.py'),
  '--context', 'ide-assistant',
  '--project', path.join(__dirname, '..'),
  '--transport', 'stdio',
  '--tool-timeout', '30',
  '--log-level', 'WARNING'
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: path.join(__dirname, '..')
});

let responseBuffer = '';
let initialized = false;
let handshakeComplete = false;

function handleResponse(data) {
  responseBuffer += data;
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.log('📨 Received:', JSON.stringify(response, null, 2));
        
        if (response.id === 1 && !initialized) {
          console.log('✅ Initialize response received');
          initialized = true;
          
          // Send initialized notification
          const initializedNotification = JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
          });
          console.log('📤 Sending initialized notification:', initializedNotification);
          mcpProcess.stdin.write(initializedNotification + '\n');
          
          // Don't send tools/list immediately - wait for language server to be ready
          
        } else if (response.id === 2 && response.result) {
          console.log('🎉 Tools list received!');
          console.log('📋 Number of tools:', response.result.tools?.length || 0);
          
          if (response.result.tools) {
            response.result.tools.forEach((tool, index) => {
              console.log(`   ${index + 1}. ${tool.name}: ${tool.description}`);
              if (tool.inputSchema) {
                console.log(`      Parameters:`, Object.keys(tool.inputSchema.properties || {}));
              }
            });
          }
          
          mcpProcess.kill();
          console.log('✅ Test completed successfully!');
        }
      } catch (e) {
        console.log('⚠️  Failed to parse JSON:', line);
      }
    }
  }
}

mcpProcess.stdout.on('data', (data) => {
  handleResponse(data.toString());
});

mcpProcess.stderr.on('data', (data) => {
  const stderr = data.toString().trim();
  console.log('🔍 Stderr:', stderr);
  
  // Check if language server initialization is complete
  if (stderr.includes('Language server initialization completed') && !handshakeComplete && initialized) {
    handshakeComplete = true;
    console.log('🚀 Language server ready, requesting tools...');
    
    const toolsRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    console.log('📤 Sending tools/list:', toolsRequest);
    mcpProcess.stdin.write(toolsRequest + '\n');
  }
});

mcpProcess.on('close', (code) => {
  console.log(`🏁 Process exited with code ${code}`);
});

mcpProcess.on('error', (error) => {
  console.error('❌ Process error:', error);
});

// Send initialize request
const initRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
});

console.log('📤 Sending initialize:', initRequest);
mcpProcess.stdin.write(initRequest + '\n');

// Timeout after 30 seconds
setTimeout(() => {
  console.log('⏰ Test timeout');
  mcpProcess.kill();
}, 30000);