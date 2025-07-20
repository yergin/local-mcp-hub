const fs = require('fs');
const http = require('http');

// Load schemas
const schemas = JSON.parse(fs.readFileSync('./tools/serena-schemas.json', 'utf8'));

// Usage guidance map
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

// Convert MCP schema to OpenAI format and enhance with usage guidance
function convertToOpenAITool(mcpTool) {
  const openaiTool = {
    type: 'function',
    function: {
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} }
    }
  };
  
  // Add usage guidance if available
  const guidance = usageMap[mcpTool.name];
  if (guidance) {
    openaiTool.function.description = `${openaiTool.function.description}. ${guidance}`;
  }
  
  return openaiTool;
}

// Convert all schemas
const openaiTools = schemas.map(convertToOpenAITool);

// Create tool descriptions for prompt
const toolDescriptions = openaiTools.map(tool => {
  const params = Object.entries(tool.function.parameters.properties || {})
    .map(([name, schema]) => `${name}: ${schema.description || schema.type}`)
    .join(', ');
  
  return `- ${tool.function.name}(${params}): ${tool.function.description}`;
}).join('\n');

// Test different user requests
const testRequests = [
  "What files are in this directory?",
  "List all files in the current folder",
  "Show me directory contents", 
  "What's in this folder?",
  "Find all TypeScript files",
  "Show me the content of package.json",
  "Search for function definitions",
  "I need help with React documentation"
];

async function testToolSelection(userRequest) {
  const toolSelectionPrompt = `You are a helpful assistant that can use tools to help users.

User request: "${userRequest}"

Available tools:
${toolDescriptions}

INSTRUCTIONS:
1. Check if the user's request matches any tool's "USE WHEN" criteria
2. If a tool matches, respond with: {"tool": "tool_name", "args": {"param": "value"}}
3. If no tool matches, respond with: {"tool": null}
4. Extract arguments from the user's request based on the tool's parameter requirements
5. Use relative paths (e.g., "." for current directory) and appropriate boolean values

RESPOND WITH ONLY THE JSON, NO OTHER TEXT.

Response:`;

  return new Promise((resolve, reject) => {
    console.log(`\n=== Testing: "${userRequest}" ===`);
    
    const postData = JSON.stringify({
      model: 'qwen2.5:latest',
      prompt: toolSelectionPrompt,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 200
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
          const result = response.response.trim().replace(/```json|```/g, '').trim();
          console.log(`LLM Response: ${result}`);
          
          try {
            const parsed = JSON.parse(result);
            console.log(`✅ Parsed successfully:`, parsed);
            if (parsed.tool) {
              console.log(`🎯 Selected tool: ${parsed.tool}`);
              console.log(`📝 Args:`, parsed.args);
            } else {
              console.log(`❌ No tool selected`);
            }
          } catch (e) {
            console.log(`❌ JSON parse error:`, e.message);
          }
          resolve();
        } catch (e) {
          console.error(`Response parse error:`, e.message);
          resolve();
        }
      });
    });
    
    req.on('error', (error) => {
      console.error(`Error testing "${userRequest}":`, error.message);
      resolve();
    });
    
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log(`Loaded ${schemas.length} MCP schemas`);
  console.log(`Enhanced ${openaiTools.length} tools with usage guidance`);
  
  // Test first few requests
  for (const request of testRequests.slice(0, 4)) {
    await testToolSelection(request);
  }
}

runTests();