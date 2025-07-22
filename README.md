# Local MCP Hub

A portable Model Context Protocol (MCP) hub that bridges VS Code Continue extension with remote Ollama servers and local MCP tools. This project enables seamless AI-assisted development with access to powerful code analysis tools and documentation lookup capabilities.

**Note: This project is entirely written by human-guided AI.**

## Architecture

```
┌─────────────────┐    HTTP/OpenAI API      ┌─────────────────┐    HTTP API      ┌─────────────────┐
│   VS Code       │ ◄─────────────────────► │  Local MCP Hub  │ ◄──────────────► │  Ollama Server  │
│ Continue Ext.   │                         │                 │                  │ (Local/Remote)  │
└─────────────────┘                         │                 │                  └─────────────────┘
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

## Key Features

- **OpenAI API Compatibility**: Drop-in replacement for OpenAI API with Continue extension
- **Remote Ollama Support**: Connect to Ollama servers running on different machines
- **Dual Model Architecture**: Separate fast and full models for optimal performance
- **MCP Tool Integration**: Access to advanced code analysis via Serena MCP server
- **Library Documentation**: Context7 integration for instant access to library docs
- **Intelligent Tool Selection**: Two-stage LLM process for smart tool selection and argument generation
- **Streaming Responses**: Real-time response streaming for better user experience
- **Code Completion**: Fill-in-middle (FIM) support for autocomplete functionality
- **Request Logging**: Comprehensive logging with configurable levels

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.9+ (for Serena MCP server)
- **Ollama** server running locally or remotely
- **VS Code** with Continue extension installed

## Installation

### Clone Repository

```bash
git clone https://github.com/yergin/local-mcp-hub
cd local-mcp-hub
```

### Platform-Specific Installation

#### Linux/macOS
```bash
chmod +x install.sh
./install.sh
```

#### macOS (Alternative)
```bash
chmod +x install-mac.sh
./install-mac.sh
```

#### Windows
```batch
install.bat
```

### Configure Ollama Server

Edit `config.json` to point to your Ollama server:

```json
{
  "ollama": {
    "host": "http://your-ollama-server:11434",
    "model": "qwen2.5:latest",
    "fast_model": "qwen2.5:0.5b"
  }
}
```

### Start the Hub

```bash
npm start
```

The hub will start on port 3002 by default.

### Configure Continue Extension

Copy the contents of `continue-config.yaml` to your Continue extension configuration file:

**Linux/macOS**: `~/.continue/config.yaml`
**Windows**: `%USERPROFILE%\.continue\config.yaml`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3002 |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | info |

## Configuration Files

### config.json

Main configuration file controlling:

- **ollama**: Ollama server connection and model settings
- **hub**: Server port, logging, and CORS configuration  
- **mcps**: Enabled MCP servers list

### prompts.json

Advanced prompt configuration for:

- **connectionTest**: Ollama connection verification prompts
- **toolSelection**: Tool selection logic and templates
- **argumentGeneration**: Argument generation for fast/full models
- **codeCompletion**: Code completion prompt templates
- **toolGuidance**: Usage hints and model routing for tools
- **responseGeneration**: Response templates for tool results
- **systemMessages**: User-facing messages for various states

## API Endpoints

### Core OpenAI Compatible Endpoints

- `POST /v1/chat/completions` - Chat completions with tool support
- `POST /v1/completions` - Code completions (FIM support)
- `GET /v1/models` - Available models list

### Administrative Endpoints

- `GET /health` - Health check and initialization status
- `GET /v1/tools` - List available MCP tools
- `POST /v1/admin/reload-prompts` - Reload prompt configuration

### Health Check Response

```json
{
  "status": "healthy",
  "timestamp": "2025-01-20T10:30:00.000Z",
  "ollama_host": "http://10.0.0.24:11434",
  "mcps_enabled": 2,
  "mcp_tools_initialized": true,
  "mcp_tools_count": 15
}
```

## Logging

Logs are written to:
- **Console**: Colored, human-readable format
- **File**: `.tmp/local-mcp-hub.log` in JSON format

Key log categories:
- HTTP requests and responses
- MCP tool calls and results
- Ollama communication
- Performance timing data
- Error tracking and debugging

## Project Structure

```
local-mcp-hub/
├── src/                    # Source code (modular architecture)
│   ├── hub.ts              # Main application server (coordination)
│   ├── ollama-client.ts    # Ollama server communication
│   ├── mcp-manager.ts      # MCP process lifecycle & tool calls
│   ├── tool-selector.ts    # Intelligent tool selection & argument generation
│   └── request-processor.ts # Request parsing & response formatting
├── mcps/                   # MCP server implementations (downloaded during installation)
│   ├── serena/             # Code analysis MCP server
│   └── context7/           # Library documentation MCP server
├── config.json             # Main configuration
├── prompts.json            # Prompt templates and tool guidance
├── continue-config.yaml    # Continue extension configuration
├── install.sh              # Linux/macOS installer
├── install-mac.sh          # macOS-specific installer
├── install.bat             # Windows installer
└── .tmp/                   # Runtime logs and debug files (created when run)
```

### Source Code Architecture

The codebase follows a modular architecture with clear separation of concerns:

- **`hub.ts`** - Main application server that coordinates all components
- **`ollama-client.ts`** - Handles all communication with Ollama servers
- **`mcp-manager.ts`** - Manages MCP process lifecycle and tool execution
- **`tool-selector.ts`** - Implements intelligent tool selection using two-stage LLM process
- **`request-processor.ts`** - Handles request parsing and response formatting

## Available Tools

| Tool Name | Description |
|-----------|-------------|
| `list_dir` | Lists all non-gitignored files and directories in the given directory (optionally with recursion). Returns a JSON object with the names of directories and files within the given directory. |
| `find_file` | Finds non-gitignored files matching the given file mask within the given relative path. Returns a JSON object with the list of matching files. |
| `replace_regex` | Replaces one or more occurrences of the given regular expression. This is the preferred way to replace content in a file whenever the symbol-level tools are not appropriate. Even large sections of code can be replaced by providing a concise regular expression of the form "beginning.*?end-of-text-to-be-replaced". Always try to use wildcards to avoid specifying the exact content of the code to be replaced, especially if it spans several lines.  IMPORTANT: REMEMBER TO USE WILDCARDS WHEN APPROPRIATE! I WILL BE VERY UNHAPPY IF YOU WRITE LONG REGEXES WITHOUT USING WILDCARDS INSTEAD!. |
| `search_for_pattern` | Offers a flexible search for arbitrary patterns in the codebase, including the possibility to search in non-code files. Generally, symbolic operations like find_symbol or find_referencing_symbols should be preferred if you know which symbols you are looking for.  Pattern Matching Logic:     For each match, the returned result will contain the full lines where the     substring pattern is found, as well as optionally some lines before and after it. The pattern will be compiled with     DOTALL, meaning that the dot will match all characters including newlines.     This also means that it never makes sense to have .* at the beginning or end of the pattern,     but it may make sense to have it in the middle for complex patterns.     If a pattern matches multiple lines, all those lines will be part of the match.     Be careful to not use greedy quantifiers unnecessarily, it is usually better to use non-greedy quantifiers like .*? to avoid     matching too much content.  File Selection Logic:     The files in which the search is performed can be restricted very flexibly.     Using `restrict_search_to_code_files` is useful if you are only interested in code symbols (i.e., those     symbols that can be manipulated with symbolic tools like find_symbol).     You can also restrict the search to a specific file or directory,     and provide glob patterns to include or exclude certain files on top of that.     The globs are matched against relative file paths from the project root (not to the `relative_path` parameter that     is used to further restrict the search).     Smartly combining the various restrictions allows you to perform very targeted searches. Returns A JSON object mapping file paths to lists of matched consecutive lines (with context, if requested). |
| `restart_language_server` | Use this tool only on explicit user request or after confirmation. It may be necessary to restart the language server if the user performs edits not through Serena, so the language server state becomes outdated and further editing attempts lead to errors.  If such editing errors happen, you should suggest using this tool. |
| `get_symbols_overview` | Gets an overview of the given file or directory. For each analyzed file, we list the top-level symbols in the file (name_path, kind). Use this tool to get a high-level understanding of the code symbols. Calling this is often a good idea before more targeted reading, searching or editing operations on the code symbols. Before requesting a symbol overview, it is usually a good idea to narrow down the scope of the overview by first understanding the basic directory structure of the repository that you can get from memories or by using the `list_dir` and `find_file` tools (or similar). Returns a JSON object mapping relative paths of all contained files to info about top-level symbols in the file (name_path, kind). |
| `find_symbol` | Retrieves information on all symbols/code entities (classes, methods, etc.) based on the given `name_path`, which represents a pattern for the symbol's path within the symbol tree of a single file. The returned symbol location can be used for edits or further queries. Specify `depth > 0` to retrieve children (e.g., methods of a class).  The matching behavior is determined by the structure of `name_path`, which can either be a simple name (e.g. "method") or a name path like "class/method" (relative name path) or "/class/method" (absolute name path). Note that the name path is not a path in the file system but rather a path in the symbol tree **within a single file**. Thus, file or directory names should never be included in the `name_path`. For restricting the search to a single file or directory, the `within_relative_path` parameter should be used instead. The retrieved symbols' `name_path` attribute will always be composed of symbol names, never file or directory names.  Key aspects of the name path matching behavior: - Trailing slashes in `name_path` play no role and are ignored. - The name of the retrieved symbols will match (either exactly or as a substring)   the last segment of `name_path`, while other segments will restrict the search to symbols that   have a desired sequence of ancestors. - If there is no starting or intermediate slash in `name_path`, there is no   restriction on the ancestor symbols. For example, passing `method` will match   against symbols with name paths like `method`, `class/method`, `class/nested_class/method`, etc. - If `name_path` contains a `/` but doesn't start with a `/`, the matching is restricted to symbols   with the same ancestors as the last segment of `name_path`. For example, passing `class/method` will match against   `class/method` as well as `nested_class/class/method` but not `method`. - If `name_path` starts with a `/`, it will be treated as an absolute name path pattern, meaning   that the first segment of it must match the first segment of the symbol's name path.   For example, passing `/class` will match only against top-level symbols like `class` but not against `nested_class/class`.   Passing `/class/method` will match against `class/method` but not `nested_class/class/method` or `method`. Returns JSON string: a list of symbols (with locations) matching the name. |
| `find_referencing_symbols` | Finds symbols that reference the symbol at the given `name_path`. The result will contain metadata about the referencing symbols as well as a short code snippet around the reference (unless `include_body` is True, then the short snippet will be omitted). Note that among other kinds of references, this function can be used to find (direct) subclasses of a class, as subclasses are referencing symbols that have the kind class. Returns a list of JSON objects with the symbols referencing the requested symbol. |
| `replace_symbol_body` | Replaces the body of the symbol with the given `name_path`. |
| `insert_after_symbol` | Inserts the given body/content after the end of the definition of the given symbol (via the symbol's location). A typical use case is to insert a new class, function, method, field or variable assignment. |
| `insert_before_symbol` | Inserts the given body/content before the beginning of the definition of the given symbol (via the symbol's location). A typical use case is to insert a new class, function, method, field or variable assignment. It also can be used to insert a new import statement before the first symbol in the file. |
| `write_memory` | Write some information about this project that can be useful for future tasks to a memory. Use markdown formatting for the content. The information should be short and to the point. The memory name should be meaningful, such that from the name you can infer what the information is about. It is better to have multiple small memories than to have a single large one because memories will be read one by one and we only ever want to read relevant memories.  This tool is either called during the onboarding process or when you have identified something worth remembering about the project from the past conversation. |
| `read_memory` | Read the content of a memory file. This tool should only be used if the information is relevant to the current task. You can infer whether the information is relevant from the memory file name. You should not read the same memory file multiple times in the same conversation. |
| `list_memories` | List available memories. Any memory can be read using the `read_memory` tool. |
| `delete_memory` | Delete a memory file. Should only happen if a user asks for it explicitly, for example by saying that the information retrieved from a memory file is no longer correct or no longer relevant for the project. |
| `activate_project` | Activates the project with the given name. |
| `remove_project` | Removes a project from the Serena configuration. |
| `switch_modes` | Activates the desired modes, like ["editing", "interactive"] or ["planning", "one-shot"]. |
| `get_current_config` | Print the current configuration of the agent, including the active and available projects, tools, contexts, and modes. |
| `check_onboarding_performed` | Checks whether project onboarding was already performed. You should always call this tool before beginning to actually work on the project/after activating a project, but after calling the initial instructions tool. |
| `onboarding` | Call this tool if onboarding was not performed yet. You will call this tool at most once per conversation. Returns instructions on how to create the onboarding information. |
| `think_about_collected_information` | Think about the collected information and whether it is sufficient and relevant. This tool should ALWAYS be called after you have completed a non-trivial sequence of searching steps like find_symbol, find_referencing_symbols, search_files_for_pattern, read_file, etc. |
| `think_about_task_adherence` | Think about the task at hand and whether you are still on track. Especially important if the conversation has been going on for a while and there has been a lot of back and forth.  This tool should ALWAYS be called before you insert, replace, or delete code. |
| `think_about_whether_you_are_done` | Whenever you feel that you are done with what the user has asked for, it is important to call this tool. |
| `summarize_changes` | Summarize the changes you have made to the codebase. This tool should always be called after you have fully completed any non-trivial coding task, but only after the think_about_whether_you_are_done call. |
| `prepare_for_new_conversation` | Instructions for preparing for a new conversation. This tool should only be called on explicit user request. |
| `initial_instructions` | Get the initial instructions for the current coding project. If you haven't received instructions on how to use Serena's tools in the system prompt, you should always call this tool before starting to work (including using any other tool) on any programming task, the only exception being when you are asked to call `activate_project`, which you should then call before. |
| `resolve-library-id` | Resolves a package/product name to a Context7-compatible library ID and returns a list of matching libraries.  You MUST call this function before 'get-library-docs' to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.  Selection Process: 1. Analyze the query to understand what library/package the user is looking for 2. Return the most relevant match based on: - Name similarity to the query (exact matches prioritized) - Description relevance to the query's intent - Documentation coverage (prioritize libraries with higher Code Snippet counts) - Trust score (consider libraries with scores of 7-10 more authoritative)  Response Format: - Return the selected library ID in a clearly marked section - Provide a brief explanation for why this library was chosen - If multiple good matches exist, acknowledge this but proceed with the most relevant one - If no good matches exist, clearly state this and suggest query refinements  For ambiguous queries, request clarification before proceeding with a best-guess match. |
| `get-library-docs` | Fetches up-to-date documentation for a library. You must call 'resolve-library-id' first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query. |

## Troubleshooting

### Common Issues

**Hub won't start**
- Check if port 3002 is available
- Verify Node.js version is 18+
- Check config.json syntax

**Ollama connection failed**
- Verify Ollama server is running
- Check network connectivity to remote host
- Confirm model names exist on Ollama server

**MCP tools not working**
- Check `.tmp/local-mcp-hub.log` for MCP process errors
- Verify Python environment for Serena (requires Python 3.9+)
- Ensure all dependencies are installed

**Continue extension not connecting**
- Verify Continue config.yaml matches provided template
- Check VS Code developer console for errors
- Confirm hub health endpoint responds: `http://localhost:3002/health`

### Debug Mode

Enable debug logging in config.json:

```json
{
  "hub": {
    "log_level": "debug"
  }
}
```

Or set environment variable:
```bash
LOG_LEVEL=debug npm start
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly with different Ollama models
5. Submit a pull request

Please ensure all changes maintain compatibility with the OpenAI API specification and Continue extension requirements.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgements

- [Ollama](https://ollama.ai) - Local language model server
- [Continue](https://continue.dev) - VS Code AI coding assistant
- [Serena](https://github.com/oraios/serena) - Semantic code analysis toolkit
- [Context7](https://github.com/upstash/context7) - Documentation search MCP
- [Model Context Protocol](https://github.com/modelcontextprotocol) - Standardized tool integration protocol