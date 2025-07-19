# Local MCP Hub

A portable MCP (Model Context Protocol) hub that runs locally on development machines while connecting to a remote Ollama server. Provides AI coding assistance with access to local code analysis and documentation tools.

## Architecture

```
Dev Machine                    Remote Server
┌─────────────────────────┐    ┌─────────────────┐
│ Local MCP Hub           │    │ Ollama Server   │
│ ├── Serena (Code)       │◄──►│ qwen2.5:latest  │
│ ├── Context7 (Docs)     │    │ Port 11434      │
│ └── OpenAI API (3002)   │    └─────────────────┘
└─────────────────────────┘
         ▲
         │
┌─────────────────────────┐
│ Continue Extension      │
│ VS Code                 │
└─────────────────────────┘
```

## Features

- 🔧 **Local Code Analysis**: 18 Serena tools for semantic code understanding
- 📚 **Documentation Search**: 2 Context7 tools for up-to-date library docs  
- 🌐 **Remote AI Processing**: Connects to remote Ollama server for model inference
- 🔌 **Continue Integration**: OpenAI-compatible API for VS Code Continue extension
- 📦 **Auto-Installer**: One-command setup that downloads and configures all dependencies
- 🖥️ **Cross-Platform**: Works on Mac, Windows, and Linux
- ⚡ **Portable**: Easy deployment across multiple development machines

## Available Tools

### Serena (18 tools)
- `list_dir`, `find_file`, `symbol_overview`, `find_symbol`
- `get_symbol_definition`, `list_symbols_in_file`, `find_references`
- `replace_symbol_body`, `search_for_pattern`, `read_file_content`
- `get_workspace_overview`, `search_symbols_in_workspace`
- `get_class_hierarchy`, `find_implementations`, `get_function_calls`
- `analyze_dependencies`, `find_similar_code`, `extract_interfaces`

### Context7 (2 tools)
- `resolve-library-id`, `get-library-docs`

## Quick Start

### Prerequisites

- Node.js (v18+)
- Python 3.8+
- Git
- Remote Ollama server running `qwen2.5:latest`

### Installation

1. **Clone and install:**
   ```bash
   git clone <repository-url>
   cd local-mcp-hub
   ./install.sh
   ```

2. **Start the hub:**
   ```bash
   npm start
   ```

3. **Configure Continue extension** in VS Code:
   ```yaml
   models:
     - name: "Local MCP Hub + Qwen2.5"
       provider: openai
       model: "qwen2.5:latest" 
       apiBase: "http://localhost:3002/v1"
       apiKey: "dummy-key"
   ```

## Configuration

### Environment Variables

- `PORT`: Override default port (3002)
- Example: `PORT=3003 npm start`

### Config File (`config.json`)

```json
{
  "ollama": {
    "host": "http://10.0.0.24:11434",
    "model": "qwen2.5:latest"
  },
  "hub": {
    "port": 3002,
    "log_level": "info",
    "cors_origins": ["*"]
  },
  "mcps": {
    "enabled": ["serena", "context7"]
  }
}
```

## Usage Examples

Ask Continue these questions to see the MCP tools in action:

- *"Can you analyze the LocalMCPHub class in my codebase? Show me its methods."*
- *"What files are in my src directory and how is the project structured?"*
- *"How does the sendToOllama method work and what error handling does it have?"*
- *"Find documentation for the latest React hooks API"* (uses Context7)

## API Endpoints

- `GET /health` - Health check
- `GET /v1/models` - Available models
- `POST /v1/chat/completions` - OpenAI-compatible chat endpoint
- `GET /v1/tools` - List available MCP tools

## Development

### Project Structure

```
local-mcp-hub/
├── src/
│   └── hub.ts              # Main hub implementation
├── mcps/                   # Auto-downloaded MCPs
│   ├── serena/            # Code analysis toolkit
│   └── context7/          # Documentation search
├── install.sh             # Auto-installer
├── config.json           # Configuration
└── continue-config.yaml   # Continue extension template
```

### Running in Development

```bash
npm run dev     # Start with ts-node
npm run build   # Build TypeScript
npm test        # Run tests
```

### Logs

Check `local-mcp-hub.log` for detailed logs including:
- MCP tool usage
- Ollama communication
- Continue extension requests

## Troubleshooting

### Port Already in Use
```bash
PORT=3003 npm start
```

### Continue Extension Not Connecting
1. Ensure hub is running: `curl http://localhost:3002/health`
2. Check Continue config uses correct port
3. Verify Continue extension is reloaded

### MCP Tools Not Working
1. Check `mcps/` directory exists with serena and context7
2. Run `./install.sh` again to re-download
3. Verify Python virtual environment: `mcps/serena/.venv/`

### Ollama Connection Issues
1. Update `config.json` with correct Ollama server address
2. Test direct connection: `curl http://your-server:11434/api/tags`
3. Ensure qwen2.5:latest model is installed on server

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Test on multiple platforms
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- [Serena](https://github.com/oraios/serena) - Semantic code analysis toolkit
- [Context7](https://github.com/upstash/context7) - Documentation search MCP
- [Ollama](https://ollama.ai) - Local language model server
- [Continue](https://continue.dev) - VS Code AI coding assistant