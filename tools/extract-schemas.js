const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('Extracting MCP schemas...');

// Test serena first
const serenaProcess = spawn(path.join(__dirname, '..', 'mcps', 'serena', '.venv', 'bin', 'python'), [
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
let schemas = [];

serenaProcess.stdout.on('data', (data) => {
  responseBuffer += data;
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        
        if (response.id === 1 && !initialized) {
          initialized = true;
          const initializedNotification = JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
          });
          serenaProcess.stdin.write(initializedNotification + '\n');
        } else if (response.id === 2 && response.result) {
          schemas = response.result.tools || [];
          console.log('Got', schemas.length, 'schemas from serena');
          fs.writeFileSync(path.join(__dirname, 'serena-schemas.json'), JSON.stringify(schemas, null, 2));
          serenaProcess.kill();
          console.log('✅ Serena schemas saved to tools/serena-schemas.json');
        }
      } catch (e) {
        // ignore parse errors
      }
    }
  }
});

serenaProcess.stderr.on('data', (data) => {
  const stderr = data.toString().trim();
  if (stderr.includes('Language server initialization completed') && initialized) {
    console.log('🚀 Language server ready, requesting tools...');
    const toolsRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    serenaProcess.stdin.write(toolsRequest + '\n');
  }
});

serenaProcess.on('close', (code) => {
  console.log(`Process exited with code ${code}`);
});

const initRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    clientInfo: { name: 'schema-extractor', version: '1.0.0' }
  }
});

serenaProcess.stdin.write(initRequest + '\n');

setTimeout(() => {
  console.log('⏰ Timeout, killing process');
  serenaProcess.kill();
}, 45000);