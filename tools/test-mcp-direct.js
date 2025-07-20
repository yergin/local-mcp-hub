const { spawn } = require('child_process');
const path = require('path');

// Test the MCP tool call format directly with Serena
function testMCPToolCall() {
  const mcpCommand = path.join(__dirname, '..', 'mcps', 'serena', '.venv', 'bin', 'python');
  const mcpArgs = [
    path.join(__dirname, '..', 'mcps', 'serena', 'scripts', 'mcp_server.py'),
    '--context', 'ide-assistant',
    '--project', path.join(__dirname, '..'),
    '--transport', 'stdio',
    '--tool-timeout', '30',
    '--log-level', 'WARNING'
  ];

  console.log('Starting MCP server...');
  
  const mcpProcess = spawn(mcpCommand, mcpArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..')
  });

  let responseBuffer = '';
  let initialized = false;

  const handleResponse = (data) => {
    responseBuffer += data;
    const lines = responseBuffer.split('\n');
    responseBuffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          console.log('📥 MCP Response:', JSON.stringify(response, null, 2));
          
          if (response.id === 1 && !initialized) {
            initialized = true;
            console.log('✅ MCP server initialized');
            
            // Send initialized notification
            const initializedNotification = JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
              params: {}
            });
            console.log('📤 Sending initialized notification');
            mcpProcess.stdin?.write(initializedNotification + '\n');
            
          } else if (response.id === 2) {
            console.log('🔧 Tools list received');
            
            // Now try to call list_dir tool
            const toolCallRequest = JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'list_dir',
                arguments: {
                  relative_path: '.',
                  recursive: false
                }
              }
            });
            
            console.log('📤 Sending tool call request:', toolCallRequest);
            mcpProcess.stdin?.write(toolCallRequest + '\n');
            mcpProcess.stdin?.end();
            
          } else if (response.id === 3) {
            console.log('🎯 Tool call response received!');
            if (response.result) {
              console.log('✅ SUCCESS: Tool executed successfully');
              console.log('📄 Result:', response.result);
            } else if (response.error) {
              console.log('❌ ERROR: Tool call failed');
              console.log('🚨 Error details:', response.error);
            }
            mcpProcess.kill();
            return;
          }
        } catch (e) {
          console.log('⚠️  Failed to parse response:', line);
        }
      }
    }
  };

  mcpProcess.stdout?.on('data', (data) => {
    handleResponse(data.toString());
  });

  mcpProcess.stderr?.on('data', (data) => {
    const stderr = data.toString();
    console.log('📋 MCP stderr:', stderr.trim());
    
    // For Serena, wait for language server to be ready
    if (stderr.includes('Language server initialization completed') && initialized) {
      console.log('🚀 Serena language server ready, sending tools/list');
      const toolsRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      });
      console.log('📤 Sending tools/list request');
      mcpProcess.stdin?.write(toolsRequest + '\n');
    }
  });

  mcpProcess.on('close', (code) => {
    console.log(`🏁 MCP process exited with code ${code}`);
  });

  mcpProcess.on('error', (error) => {
    console.error('💥 MCP process error:', error);
  });

  // Initialize
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

  console.log('📤 Sending init request:', initRequest);
  mcpProcess.stdin?.write(initRequest + '\n');

  // Timeout
  setTimeout(() => {
    console.log('⏰ Test timeout - killing process');
    mcpProcess.kill();
  }, 60000);
}

testMCPToolCall();