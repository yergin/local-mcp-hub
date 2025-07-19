# Local MCP Hub Development Tools

This directory contains development and debugging tools for the Local MCP Hub project.

## test-completion.js

A testing tool that analyzes code completion requests and tests them against Ollama.

### Usage

1. Trigger a completion request in VS Code (this creates `.tmp/compreq.json`)
2. Run the testing tool:
   ```bash
   node tools/test-completion.js
   ```

### What it does

- Loads completion requests from `.tmp/compreq.json` 
- Uses settings from `config.json` (Ollama host, model, etc.)
- Parses FIM (Fill-In-Middle) requests correctly
- Generates the same prompt as the hub server
- Tests the prompt against Ollama directly
- Analyzes the response for correctness
- Shows detailed debugging information

### Output

The tool provides comprehensive analysis including:
- Original request parameters
- FIM parsing results  
- Context extraction details
- Generated prompt
- Ollama response
- Response analysis (prefix matching, etc.)

This helps debug issues with autocomplete behavior by comparing what the hub sends vs. what Ollama returns.