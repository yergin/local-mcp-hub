const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// Load schemas and setup
const schemas = JSON.parse(fs.readFileSync('./tools/serena-schemas.json', 'utf8'));

const usageMap = {
  'list_dir': 'USE WHEN: user asks "what files are in", "list files", "show directory contents", "what\'s in this folder"',
  'find_file': 'USE WHEN: user wants to find specific files by name or pattern like "find *.js files" or "where is config.json"',
  'read_file_content': 'USE WHEN: user wants to see the contents of a specific file',
  'search_for_pattern': 'USE WHEN: user wants to search for code patterns or text within files',
  'get_symbols_overview': 'USE WHEN: user wants to understand the structure/symbols in code files',
  'find_symbol': 'USE WHEN: user is looking for specific functions, classes, or variables in code',
  'replace_symbol_body': 'USE WHEN: user wants to modify/replace specific functions or code blocks',
  'get-library-docs': 'USE WHEN: user asks about documentation for a specific library or framework'
};

function convertToOpenAITool(mcpTool) {
  const openaiTool = {
    type: 'function',
    function: {
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} }
    }
  };
  
  const guidance = usageMap[mcpTool.name];
  if (guidance) {
    openaiTool.function.description = `${openaiTool.function.description}. ${guidance}`;
  }
  
  return openaiTool;
}

const openaiTools = schemas.map(convertToOpenAITool);

async function sendToOllama(prompt, temperature = 0.1, maxTokens = 200) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'qwen2.5:latest',
      prompt: prompt,
      stream: false,
      options: {
        temperature: temperature,
        num_predict: maxTokens
      }
    });
    
    const options = {
      hostname: '10.0.0.24',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response.response);
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function stageOneToolSelection(userRequest) {
  console.log(`\n🎯 STAGE 1: Tool Selection for "${userRequest}"`);
  
  // Create concise tool list (names + USE WHEN only)
  const toolNames = openaiTools.map(tool => {
    const guidance = usageMap[tool.function.name] || '';
    const shortDesc = tool.function.description.split('.')[0];
    return `- ${tool.function.name}: ${shortDesc}${guidance ? '. ' + guidance : ''}`;
  }).join('\n');
  
  const toolSelectionPrompt = `You are a helpful assistant that can use tools to help users.

User request: "${userRequest}"

Available tools:
${toolNames}

INSTRUCTIONS:
1. Check if the user's request matches any tool's "USE WHEN" criteria
2. If a tool matches, respond with: {"tool": "tool_name"}
3. If no tool matches, respond with: {"tool": null}

RESPOND WITH ONLY THE JSON, NO OTHER TEXT.

Response:`;

  console.log(`📏 Stage 1 prompt length: ${toolSelectionPrompt.length} chars`);
  
  const response = await sendToOllama(toolSelectionPrompt, 0.1, 100);
  const cleanResponse = response.trim().replace(/```json|```/g, '').trim();
  
  console.log(`📤 Stage 1 LLM response: ${cleanResponse}`);
  
  try {
    const selection = JSON.parse(cleanResponse);
    if (selection.tool && selection.tool !== null) {
      console.log(`✅ Stage 1 SUCCESS: Selected tool "${selection.tool}"`);
      return selection.tool;
    } else {
      console.log(`❌ Stage 1: No tool selected`);
      return null;
    }
  } catch (e) {
    console.log(`❌ Stage 1: JSON parse error - ${e.message}`);
    return null;
  }
}

async function stageTwoArgumentGeneration(userRequest, toolName) {
  console.log(`\n⚙️  STAGE 2: Argument Generation for tool "${toolName}"`);
  
  // Find the selected tool schema
  const selectedTool = openaiTools.find(t => t.function.name === toolName);
  if (!selectedTool) {
    throw new Error(`Tool ${toolName} not found in schemas`);
  }
  
  const params = Object.entries(selectedTool.function.parameters.properties || {})
    .map(([name, schema]) => `- ${name} (${schema.type}): ${schema.description || 'No description'}`)
    .join('\n');
  
  const argsPrompt = `You are a helpful assistant that generates tool arguments.

User request: "${userRequest}"
Selected tool: ${selectedTool.function.name}

Tool description: ${selectedTool.function.description}

Parameters:
${params}

INSTRUCTIONS:
1. Extract arguments from the user's request based on the tool's parameter requirements
2. Use relative paths (e.g., "." for current directory) and appropriate boolean values
3. Respond with: {"args": {"param1": "value1", "param2": "value2"}}

RESPOND WITH ONLY THE JSON, NO OTHER TEXT.

Response:`;
  
  console.log(`📏 Stage 2 prompt length: ${argsPrompt.length} chars`);
  
  const response = await sendToOllama(argsPrompt, 0.1, 150);
  const cleanResponse = response.trim().replace(/```json|```/g, '').trim();
  
  console.log(`📤 Stage 2 LLM response: ${cleanResponse}`);
  
  try {
    const argsSelection = JSON.parse(cleanResponse);
    console.log(`✅ Stage 2 SUCCESS: Generated args:`, argsSelection.args);
    return argsSelection.args || {};
  } catch (e) {
    console.log(`❌ Stage 2: JSON parse error - ${e.message}`);
    return {};
  }
}

async function stageThreeMCPExecution(toolName, args) {
  console.log(`\n🔧 STAGE 3: MCP Tool Execution`);
  console.log(`Tool: ${toolName}, Args:`, args);
  
  return new Promise((resolve, reject) => {
    const mcpCommand = path.join(__dirname, '..', 'mcps', 'serena', '.venv', 'bin', 'python');
    const mcpArgs = [
      path.join(__dirname, '..', 'mcps', 'serena', 'scripts', 'mcp_server.py'),
      '--context', 'ide-assistant',
      '--project', path.join(__dirname, '..'),
      '--transport', 'stdio',
      '--tool-timeout', '30',
      '--log-level', 'WARNING'
    ];

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
            
            if (response.id === 1 && !initialized) {
              initialized = true;
              console.log('🔄 MCP server initialized');
              
              const initializedNotification = JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
              });
              mcpProcess.stdin?.write(initializedNotification + '\n');
              
            } else if (response.id === 2) {
              console.log('📋 Tools list received');
              
              const toolCallRequest = JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: {
                  name: toolName,
                  arguments: args
                }
              });
              
              console.log('📤 SENDING MCP TOOL CALL REQUEST:');
              console.log('📝 Request JSON:', toolCallRequest);
              console.log('🔧 Tool name:', toolName);
              console.log('📋 Args object:', JSON.stringify(args, null, 2));
              mcpProcess.stdin?.write(toolCallRequest + '\n');
              mcpProcess.stdin?.end();
              
            } else if (response.id === 3) {
              console.log('🎯 Tool call response received!');
              if (response.result) {
                let resultData = 'Tool executed successfully';
                
                if (response.result.structuredContent && response.result.structuredContent.result) {
                  resultData = response.result.structuredContent.result;
                } else if (response.result.content && response.result.content.length > 0) {
                  resultData = response.result.content[0].text || JSON.stringify(response.result.content);
                } else {
                  resultData = JSON.stringify(response.result);
                }
                
                console.log('✅ Stage 3 SUCCESS: Tool executed');
                console.log('📄 Result:', resultData);
                resolve(resultData);
              } else if (response.error) {
                console.log('❌ Stage 3 ERROR:', response.error);
                reject(new Error(`MCP tool error: ${response.error.message}`));
              }
              mcpProcess.kill();
              return;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    };

    mcpProcess.stdout?.on('data', (data) => {
      handleResponse(data.toString());
    });

    mcpProcess.stderr?.on('data', (data) => {
      const stderr = data.toString();
      if (stderr.includes('Language server initialization completed') && initialized) {
        console.log('🚀 Serena language server ready');
        const toolsRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        });
        mcpProcess.stdin?.write(toolsRequest + '\n');
      }
    });

    mcpProcess.on('error', reject);

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

    mcpProcess.stdin?.write(initRequest + '\n');

    setTimeout(() => {
      mcpProcess.kill();
      reject(new Error('MCP timeout'));
    }, 60000);
  });
}

async function stageFourFinalResponse(userRequest, toolResult) {
  console.log(`\n📝 STAGE 4: Generate Final Response`);
  
  const finalPrompt = `You are a helpful assistant. A user asked: "${userRequest}"

I used a tool to get this information:
${toolResult}

Based on this tool result, provide a helpful and clear response to the user's question. Summarize the information in a user-friendly way.`;

  const response = await sendToOllama(finalPrompt, 0.7, 500);
  console.log('✅ Stage 4 SUCCESS: Final response generated');
  console.log('💬 Final Response:', response);
  return response;
}

async function testCompleteTwoStageFlow(userRequest) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 TESTING COMPLETE TWO-STAGE FLOW`);
  console.log(`📝 User Request: "${userRequest}"`);
  console.log(`${'='.repeat(60)}`);
  
  try {
    // Stage 1: Tool Selection
    const selectedTool = await stageOneToolSelection(userRequest);
    if (!selectedTool) {
      console.log('🚫 No tool selected - would fall back to normal chat');
      return;
    }
    
    // Stage 2: Argument Generation  
    const args = await stageTwoArgumentGeneration(userRequest, selectedTool);
    
    // Stage 3: MCP Tool Execution
    const toolResult = await stageThreeMCPExecution(selectedTool, args);
    
    // Stage 4: Final Response Generation
    const finalResponse = await stageFourFinalResponse(userRequest, toolResult);
    
    console.log(`\n🎉 COMPLETE SUCCESS!`);
    console.log(`User: ${userRequest}`);
    console.log(`Assistant: ${finalResponse}`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Test the complete flow
testCompleteTwoStageFlow("What files are in this directory?");