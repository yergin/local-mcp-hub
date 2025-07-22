# Local MCP Hub API Call Flow Documentation

This document details the exact API calls and communication flows between all components when a prompt is entered in the VS Code Continue extension.

## Architecture Overview

```
┌─────────────────┐    OpenAI API       ┌─────────────────┐    Ollama API       ┌─────────────────┐
│   VS Code       │ ◄─────────────────► │  Local MCP Hub  │ ◄─────────────────► │  Ollama Server  │
│ Continue Ext.   │                     │                 │                     │ (Remote/Local)  │
└─────────────────┘                     │                 │                     └─────────────────┘
                                        │                 │
                                        │     ┌───────────▼──────────┐
                                        │     │    MCP Processes     │
                                        │     │                      │
                                        │     │  ┌─────────────────┐ │
                                        │     │  │     Serena      │ │
                                        │     │  │ (Code Analysis) │ │
                                        │     │  └─────────────────┘ │
                                        │     │                      │
                                        │     │  ┌─────────────────┐ │
                                        │     │  │    Context7     │ │
                                        │     │  │ (Library Docs)  │ │
                                        │     │  └─────────────────┘ │
                                        │     └──────────────────────┘
                                        └─────────────────┘
```

## Complete API Call Flow When User Enters a Prompt

### Phase 1: VS Code Continue Extension → Local MCP Hub

#### 1.1 Initial Chat Completion Request
**Endpoint:** `POST http://localhost:3002/v1/chat/completions`

**Request Headers:**
```http
Content-Type: application/json
User-Agent: Continue-VSCode
Authorization: Bearer dummy-key
```

**Request Body:**
```json
{
  "messages": [
    {
      "role": "system",
      "content": "<important_rules>\n  You are in agent mode.\n\n  Always include the language and file name in the info string when you write code blocks.\n  If you are editing \"src/main.py\" for example, your code block should start with '```python src/main.py'\n\n</important_rules>"
    },
    {
      "role": "user", 
      "content": "list out all the files and folders in this project."
    }
  ],
  "model": "qwen2.5:latest",
  "temperature": 0.2,
  "max_tokens": 4000,
  "stream": true,
  "parallel_tool_calls": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Use this tool if you need to view the contents of an existing file.",
        "parameters": {
          "type": "object",
          "properties": {
            "filepath": {
              "type": "string",
              "description": "The path of the file to read, relative to the root of the workspace (NOT uri or absolute path)"
            }
          },
          "required": ["filepath"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "ls",
        "description": "List files and folders in a given directory",
        "parameters": {
          "type": "object",
          "properties": {
            "dirPath": {
              "type": "string",
              "description": "The directory path relative to the root of the project. Always use forward slash paths like '/'. rather than e.g. '.'"
            },
            "recursive": {
              "type": "boolean",
              "description": "If true, lists files and folders recursively. To prevent unexpected large results, use this sparingly"
            }
          },
          "required": ["dirPath", "recursive"]
        }
      }
    }
    // ... 11 more tools from Continue extension
  ]
}
```

**Code Location:** `hub.ts:268` - POST `/v1/chat/completions` handler

### Phase 2: Local MCP Hub Processing

#### 2.1 Request Processing and Tool Detection
**Code Flow:**
1. `hub.ts:274-286` - Parse request body and validate messages
2. `hub.ts:289` - Check for tool results in messages
3. `hub.ts:303-310` - Detect tools from Continue extension

#### 2.2 MCP Tool Schema Initialization Check
**Code Flow:**
1. `hub.ts:311` - Check if MCP tools are initialized (`mcpManager.isInitialized`)
2. If not initialized: `hub.ts:312-320` - Send initialization message to user

#### 2.3 Tool Selection Process (Two-Stage LLM)

##### Stage 1: Tool Selection with Fast Model
**Code Flow:** `tool-selector.ts:93-196`

**Internal API Call to Ollama (Fast Model):**
```http
POST http://10.0.0.24:11434/api/generate
Content-Type: application/json

{
  "model": "qwen2.5:0.5b",
  "prompt": "You are a helpful assistant that can use tools to help users.\n\nUser request: \"list out all the files and folders in this project.\"\n\nAvailable tools:\n- list_dir: Lists all non-gitignored files and directories in the given directory (optionally with recursion). USE WHEN: user asks \"what files are in\", \"list files\", \"show directory contents\", \"what's in this folder\", \"explore directory structure\"\n- find_file: Finds non-gitignored files matching the given file mask within the given relative path. USE WHEN: user wants to find files by NAME/PATH/EXTENSION like \"find config.json\", \"find *.js files\", \"where is package.json\", \"locate main.py\"\n// ... 27 more tool descriptions\n\nINSTRUCTIONS:\n1. Check if the user's request matches any tool's \"USE WHEN\" criteria\n2. If a tool matches, respond with: {\"tool\": \"tool_name\"}\n3. If no tool matches, respond with: {\"tool\": null}\n\nRESPOND WITH ONLY THE JSON, NO OTHER TEXT.\n\nResponse:",
  "stream": false,
  "options": {
    "temperature": 0.1,
    "num_predict": 100
  }
}
```

**Response:**
```json
{
  "model": "qwen2.5:0.5b",
  "created_at": "2025-07-22T06:18:43.498413559Z",
  "response": "{\"tool\": \"list_dir\"}",
  "done": true,
  "context": [151644, 8948, 198, 2610, 525, 1207, 16948, 11, 3465, 553, 54364, 14817],
  "total_duration": 4756131227,
  "load_duration": 39887813,
  "prompt_eval_count": 1587,
  "prompt_eval_duration": 1950257037,
  "eval_count": 15,
  "eval_duration": 2764986377
}
```

##### Stage 2: Argument Generation
**Code Flow:** `tool-selector.ts:166-196`

**Internal API Call to Ollama (Fast Model for Simple Arguments):**
```http
POST http://10.0.0.24:11434/api/generate
Content-Type: application/json

{
  "model": "qwen2.5:0.5b",
  "prompt": "Generate tool arguments from user request.\n\nTool: list_dir\nUser request: \"list out all the files and folders in this project.\"\n\nParameters:\n- relative_path (string): The relative path to the directory to list; pass \".\" to scan the project root.\n- recursive (boolean): Whether to scan subdirectories recursively.\n- max_answer_chars (integer): If the output is longer than this number of characters, no content will be returned.\n\nCommon patterns:\n- For directory operations: use \".\" for current directory\n- For boolean flags: true if mentioned (recursive, etc.)\n- OMIT optional parameters that have good defaults unless user specifically requests different values\n\nRespond ONLY with JSON: {\"args\": {\"param\": \"value\"}}\n\nResponse:",
  "stream": false,
  "options": {
    "temperature": 0.1
  }
}
```

**Response:**
```json
{
  "model": "qwen2.5:0.5b",
  "created_at": "2025-07-22T06:18:46.555213559Z",
  "response": "{\"args\": {\"relative_path\": \".\", \"recursive\": false, \"max_answer_chars\": 1024}}",
  "done": true,
  "context": [151644, 8948, 198, 2610, 525, 1207, 16948, 11, 3465, 553, 54364, 14817],
  "total_duration": 2651664324,
  "load_duration": 39887813,
  "prompt_eval_count": 221,
  "prompt_eval_duration": 587976476,
  "eval_count": 25,
  "eval_duration": 2022788907
}
```

### Phase 3: MCP Tool Execution

#### 3.1 Safety Check and Tool Execution
**Code Flow:** `hub.ts:344-404`

1. `tool-selector.ts:85` - Check if tool is marked as "safe" for auto-execution
2. If safe: Proceed with execution
3. If not safe: Ask user for permission

#### 3.2 MCP Process Communication (JSON-RPC 2.0)
**Code Flow:** `mcp-manager.ts:256-389`

**Tool Call to Serena MCP Server:**
```json
{
  "jsonrpc": "2.0",
  "id": 1753165126561,
  "method": "tools/call",
  "params": {
    "name": "list_dir",
    "arguments": {
      "relative_path": ".",
      "recursive": false
    }
  }
}
```

**Serena Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1753165126561,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"dirs\": [\"src\", \".serena\"], \"files\": [\"config.json\", \"install.sh\", \"OPTIMIZATION_RESULTS.md\", \"restart-hub.sh\", \"tsconfig.json\", \"LICENSE\", \"TIMING_ANALYSIS.md\", \"package-lock.json\", \".prettierignore\", \".prettierrc\", \"API_CALL_FLOW_DOCUMENTATION.md\", \"README.md\", \"continue-config.yaml\", \"install-mac.sh\", \"package.json\", \"install.bat\", \".gitignore\", \"prompts.json\", \"PROGRESS.md\"]}"
      }
    ],
    "structuredContent": {
      "result": "{\"dirs\": [\"src\", \".serena\"], \"files\": [\"config.json\", \"install.sh\", \"OPTIMIZATION_RESULTS.md\", \"restart-hub.sh\", \"tsconfig.json\", \"LICENSE\", \"TIMING_ANALYSIS.md\", \"package-lock.json\", \".prettierignore\", \".prettierrc\", \"API_CALL_FLOW_DOCUMENTATION.md\", \"README.md\", \"continue-config.yaml\", \"install-mac.sh\", \"package.json\", \"install.bat\", \".gitignore\", \"prompts.json\", \"PROGRESS.md\"]}"
    },
    "isError": false
  }
}
```

### Phase 4: Response Generation with Tool Results

#### 4.1 Final Response Generation
**Code Flow:** `request-processor.ts:158-197`

**API Call to Ollama for Final Response:**
```http
POST http://10.0.0.24:11434/api/generate
Content-Type: application/json

{
  "model": "qwen2.5:latest",
  "prompt": "system: <important_rules>\n  You are in agent mode.\n\n  Always include the language and file name in the info string when you write code blocks.\n  If you are editing \"src/main.py\" for example, your code block should start with '```python src/main.py'\n\n</important_rules>\n\nuser: list out all the files and folders in this project.\n\nassistant: I'll use the list_dir tool to help answer your question.\n\nTool Execution Results:\nTool 1: list_dir\nStatus: Executed successfully with results\nOutput: {\"dirs\": [\"src\", \".serena\"], \"files\": [\"config.json\", \"install.sh\", \"OPTIMIZATION_RESULTS.md\", \"restart-hub.sh\", \"tsconfig.json\", \"LICENSE\", \"TIMING_ANALYSIS.md\", \"package-lock.json\", \".prettierignore\", \".prettierrc\", \"API_CALL_FLOW_DOCUMENTATION.md\", \"README.md\", \"continue-config.yaml\", \"install-mac.sh\", \"package.json\", \"install.bat\", \".gitignore\", \"prompts.json\", \"PROGRESS.md\"]}\n\nBased on the tool execution results above, provide a helpful and accurate response to the user.",
  "stream": true,
  "options": {
    "temperature": 0.2,
    "num_predict": 4000
  }
}
```

#### 4.2 Streaming Response Back to Continue Extension
**Code Flow:** `ollama-client.ts:61-210`

**Streaming Response to Continue Extension:**
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Access-Control-Allow-Origin: *

data: {"id":"chatcmpl-1703072400000","object":"chat.completion.chunk","created":1703072400,"model":"qwen2.5:latest","choices":[{"index":0,"delta":{"content":"Based"},"finish_reason":null}]}

data: {"id":"chatcmpl-1703072400000","object":"chat.completion.chunk","created":1703072400,"model":"qwen2.5:latest","choices":[{"index":0,"delta":{"content":" on"},"finish_reason":null}]}

data: {"id":"chatcmpl-1703072400000","object":"chat.completion.chunk","created":1703072400,"model":"qwen2.5:latest","choices":[{"index":0,"delta":{"content":" the"},"finish_reason":null}]}

...

data: {"id":"chatcmpl-1703072400000","object":"chat.completion.chunk","created":1703072400,"model":"qwen2.5:latest","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":250,"completion_tokens":180,"total_tokens":430}}

data: [DONE]
```

## Detailed API Specifications

### 1. VS Code Continue Extension ↔ Local MCP Hub

#### Chat Completions
- **Method:** POST
- **Endpoint:** `/v1/chat/completions`
- **Protocol:** OpenAI-compatible HTTP API
- **Authentication:** Bearer token (dummy-key)
- **Content-Type:** application/json
- **Streaming:** Server-Sent Events (SSE)

#### Code Completions (FIM - Fill-in-Middle)
- **Method:** POST
- **Endpoint:** `/v1/completions`
- **Protocol:** OpenAI-compatible HTTP API
- **Special Tokens:** `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`

#### Health Check
- **Method:** GET
- **Endpoint:** `/health`
- **Response:** JSON status object

#### Models List
- **Method:** GET
- **Endpoint:** `/v1/models`
- **Response:** OpenAI-compatible models list

### 2. Local MCP Hub ↔ Ollama Server

#### Text Generation
- **Method:** POST
- **Endpoint:** `http://10.0.0.24:11434/api/generate`
- **Protocol:** Ollama HTTP API
- **Content-Type:** application/json
- **Streaming:** Available (line-delimited JSON)

**Request Structure:**
```json
{
  "model": "qwen2.5:latest|qwen2.5:0.5b",
  "prompt": "string",
  "stream": false,
  "options": {
    "temperature": 0.1-1.0,
    "num_predict": 50-4000
  }
}
```

### 3. Local MCP Hub ↔ MCP Processes

#### Protocol: JSON-RPC 2.0 over STDIO

#### Initialization Sequence
1. **Initialize Request:**
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-06-18",
       "capabilities": { "tools": {} },
       "clientInfo": { "name": "local-mcp-hub", "version": "1.0.0" }
     }
   }
   ```

2. **Initialized Notification:**
   ```json
   {
     "jsonrpc": "2.0",
     "method": "notifications/initialized",
     "params": {}
   }
   ```

3. **Tools List Request:**
   ```json
   {
     "jsonrpc": "2.0",
     "id": 2,
     "method": "tools/list",
     "params": {}
   }
   ```

#### Tool Execution
```json
{
  "jsonrpc": "2.0",
  "id": 1703072400000,
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": { ... }
  }
}
```

## Performance Timing Data

Based on code analysis, the following timing metrics are logged:

- **MCP tools retrieval:** `hub.ts:324-327`
- **Tool selection (Stage 1):** `tool-selector.ts:131`
- **Argument generation (Stage 2):** `tool-selector.ts:184`
- **Tool execution:** `mcp-manager.ts:293-296`
- **Final response generation:** `hub.ts:379`
- **Total chat completion request:** `hub.ts:381` and `hub.ts:437`

## Error Handling and Fallbacks

1. **MCP Not Initialized:** Send initialization message to user
2. **Tool Execution Failure:** Fall back to permission request
3. **Ollama Connection Issues:** Error response with details
4. **JSON Parsing Errors:** Logged and handled gracefully
5. **Timeout Handling:** 30-second timeout for MCP tool calls

## Configuration Points

- **Ollama Host:** `config.json:ollama.host`
- **Models:** `config.json:ollama.model` and `config.json:ollama.fast_model`
- **Hub Port:** `config.json:hub.port`
- **Enabled MCP Servers:** `config.json:mcps.enabled`
- **CORS Origins:** `config.json:hub.cors_origins`
- **Tool Safety Configuration:** `prompts.json:toolGuidance.safeTools`
- **Fast Model Tools:** `prompts.json:toolGuidance.fastModelTools`

This documentation provides a complete picture of every API call and communication flow that occurs when a user enters a prompt in the Continue extension.