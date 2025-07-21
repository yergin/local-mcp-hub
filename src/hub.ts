import express from 'express';
import cors from 'cors';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

// Completion interfaces
interface FIMRequest {
  prefix: string;
  suffix: string;
  isFIM: boolean;
}

// OpenAI Tool interfaces
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

interface CompletionContext {
  prefix: string;
  suffix: string;
  cleanPrefix: string;
}

// Configuration interface
interface Config {
  ollama: {
    host: string;
    model: string;
    fast_model: string;
  };
  hub: {
    port: number;
    log_level: string;
    cors_origins: string[];
  };
  mcps: {
    enabled: string[];
  };
}

// Logger setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'local-mcp-hub.log' })
  ]
});

class LocalMCPHub {
  private app: express.Application;
  private config: Config;
  private mcpToolSchemas: Map<string, OpenAITool> = new Map();
  private schemasInitialized: boolean = false;
  private mcpProcesses: Map<string, ChildProcess> = new Map();
  private mcpProcessReady: Map<string, boolean> = new Map();

  constructor() {
    this.app = express();
    this.config = this.loadConfig();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private loadConfig(): Config {
    try {
      const configPath = path.join(__dirname, '..', 'config.json');
      const configData = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData) as Config;
      logger.info(`Loaded configuration: Ollama at ${config.ollama.host}`);
      return config;
    } catch (error) {
      logger.error('Failed to load configuration:', error);
      process.exit(1);
    }
  }

  private setupMiddleware(): void {
    // Enhanced CORS configuration for Continue extension compatibility
    this.app.use(cors({
      origin: this.config.hub.cors_origins || ['*'],
      credentials: true,
      allowedHeaders: [
        'Authorization',
        'Content-Type', 
        'Accept',
        'Origin',
        'X-Requested-With',
        'Cache-Control'
      ],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['Content-Type', 'Cache-Control', 'Connection']
    }));

    // Additional CORS headers for streaming
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Origin, X-Requested-With, Cache-Control');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Expose-Headers', 'Content-Type, Cache-Control, Connection');
      
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }
      next();
    });
    
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    
    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} - ${req.ip}`);
      if (req.headers.authorization) {
        logger.debug('Authorization header present:', req.headers.authorization.substring(0, 20) + '...');
      }
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        ollama_host: this.config.ollama.host,
        mcps_enabled: this.config.mcps.enabled.length,
        mcp_tools_initialized: this.schemasInitialized,
        mcp_tools_count: this.mcpToolSchemas.size
      });
    });

    // OpenAI-compatible chat completions
    this.app.post('/v1/chat/completions', async (req, res) => {
      const startTime = Date.now();
      try {
        logger.info(`⏱️ TIMING: Chat completion request received at ${startTime}`);
        logger.debug('Request body:', JSON.stringify(req.body, null, 2));
        
        const { messages, model, temperature = 0.7, max_tokens = 4000, stream = false, tools, tool_choice } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: 'Invalid messages format' });
        }

        // Check if this is a tool call response (messages contain tool results)
        const hasToolResults = messages.some(msg => msg.role === 'tool');
        
        if (hasToolResults) {
          // Generate final response using tool results
          const response = await this.generateResponseWithToolResults(messages, temperature, max_tokens);
          this.sendStreamingResponse(res, response);
          return;
        }
        
        // Check if tools are available and replace with our MCP tools
        if (tools && tools.length > 0) {
          logger.info(`Tools received from Continue: ${tools.length} tools found`);
          logger.debug('Continue tools:', tools.map((t: OpenAITool) => t.function.name));
          
          // Check if MCP tools are initialized yet
          if (!this.schemasInitialized) {
            logger.warn('MCP tools not yet initialized, sending initialization message');
            const initMessage = `🔧 Local MCP Hub is still initializing the code analysis tools (Serena & Context7). This usually takes 10-30 seconds after startup. Please try your request again in a moment.

Current status:
- Hub server: ✅ Running
- Ollama connection: ✅ Connected  
- MCP tools: ⏳ Loading...

You can check initialization status at: http://localhost:${this.config.hub.port}/health`;

            this.sendStreamingResponse(res, initMessage);
            return;
          }
          
          // Replace Continue's tools with our MCP tools
          const toolsStartTime = Date.now();
          const mcpTools = this.getOpenAITools();
          logger.info(`⏱️ TIMING: Got MCP tools in ${Date.now() - toolsStartTime}ms (${mcpTools.length} tools)`);
          logger.debug('MCP tools:', mcpTools.map((t: OpenAITool) => t.function.name));
          
          const selectionStartTime = Date.now();
          const toolSelection = await this.selectToolWithLLM(messages, mcpTools);
          logger.info(`⏱️ TIMING: Tool selection completed in ${Date.now() - selectionStartTime}ms`);
          logger.info(`Tool selection result: ${JSON.stringify(toolSelection)}`);
          
          if (toolSelection) {
            logger.info(`Processing tool selection: ${toolSelection.tool}`);
            
            // Check if this is a safe tool that can be auto-executed
            if (this.isSafeTool(toolSelection.tool)) {
              logger.info(`Auto-executing safe tool: ${toolSelection.tool}`);
              
              try {
                // Execute the tool automatically
                const toolExecStartTime = Date.now();
                const toolResult = await this.callMCPTool(toolSelection.tool, toolSelection.args);
                logger.info(`⏱️ TIMING: Tool execution (${toolSelection.tool}) completed in ${Date.now() - toolExecStartTime}ms`);
                logger.info(`Tool executed successfully, result length: ${toolResult.length}`);
                
                // Create messages with tool result for final response
                const messagesWithTool = [
                  ...messages,
                  {
                    role: 'assistant', 
                    content: `I'll use the ${toolSelection.tool} tool to help answer your question.`
                  },
                  {
                    role: 'tool',
                    content: toolResult,
                    name: toolSelection.tool
                  }
                ];
                
                const finalResponseStartTime = Date.now();
                logger.info('🌊 Starting streaming final response generation');
                await this.generateResponseWithToolResultsStreaming(messagesWithTool, temperature, max_tokens, res);
                logger.info(`⏱️ TIMING: Final response generation completed in ${Date.now() - finalResponseStartTime}ms`);
                
                logger.info(`⏱️ TIMING: Total request processing time: ${Date.now() - startTime}ms`);
                return;
                
              } catch (toolError) {
                logger.error('Tool execution failed:', toolError);
                
                // Fall back to asking for permission
                const permissionResponse = `I'd like to use the ${toolSelection.tool} tool to answer your question, but I encountered an error: ${toolError instanceof Error ? toolError.message : 'Unknown error'}. Would you like me to try a different approach?`;
                
                this.sendStreamingResponse(res, permissionResponse);
                return;
              }
              
            } else {
              // Ask for permission for potentially unsafe tools
              logger.info(`Asking permission for potentially unsafe tool: ${toolSelection.tool}`);
              
              const permissionMessage = `I'd like to use the ${toolSelection.tool} tool with these parameters: ${JSON.stringify(toolSelection.args)}. This tool may modify files or system state. Would you like me to proceed? (Please respond with 'yes' to continue or 'no' to cancel)`;
              
              this.sendStreamingResponse(res, permissionMessage);
              return;
            }
          }
        }
        
        // No tools needed, generate normal response
        const promptStartTime = Date.now();
        const basePrompt = this.convertMessagesToPrompt(messages);
        const prompt = await this.enhancePromptWithTools(basePrompt);
        logger.info(`⏱️ TIMING: Prompt preparation completed in ${Date.now() - promptStartTime}ms`);
        
        // Always send streaming response to Continue (ignoring stream parameter)
        const ollamaStartTime = Date.now();
        logger.info('🌊 Starting streaming response for regular chat');
        await this.sendToOllamaStreaming(prompt, temperature, max_tokens, res);
        logger.info(`⏱️ TIMING: Ollama response completed in ${Date.now() - ollamaStartTime}ms`);
        
        logger.info(`⏱️ TIMING: Total request processing time: ${Date.now() - startTime}ms`);
        
        logger.info('Successfully processed chat completion');
        
      } catch (error) {
        logger.error('Error in chat completion:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Completions endpoint for code autocomplete
    this.app.post('/v1/completions', async (req, res) => {
      try {
        logger.info('Received completion request');
        
        // Store first completion request for debugging
        const tmpDir = path.join(__dirname, '..', '.tmp');
        const compreqPath = path.join(tmpDir, 'compreq.json');
        if (!fs.existsSync(compreqPath)) {
          // Ensure .tmp directory exists
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }
          fs.writeFileSync(compreqPath, JSON.stringify(req.body, null, 2));
          logger.info('Stored completion request to .tmp/compreq.json');
        }
        
        const { prompt, max_tokens = 50, temperature = 0.2, stream = false } = req.body;
        
        if (!prompt) {
          return res.status(400).json({ error: 'Prompt is required' });
        }

        // Parse FIM request and create context-aware completion
        
        const fimRequest = this.parseFIMRequest(prompt);
        
        // Extract the immediate code before cursor (last line)
        const lines = fimRequest.prefix.split('\n');
        const codeBeforeCursor = lines[lines.length - 1] || '';
        
        // Extract only the last file path for language context
        const filePathLines = lines
          .filter(line => line.trim().startsWith('// Path: '))
          .map(line => line.trim());
        const languageContext = filePathLines.length > 0 ? filePathLines[filePathLines.length - 1] : '';

        // Create context-aware completion prompt
        const completionPrompt = `You are an efficient code completion assistant. Your goal is to save the developer time by writing as much useful, correct code as possible.

File: ${languageContext.replace('// Path: ', '')}
Code before cursor: ${codeBeforeCursor}
Code after cursor: ${fimRequest.suffix}

Your response must start with the exact text "${codeBeforeCursor}" character-for-character, then continue with your completion, and include the suffix "${fimRequest.suffix}". Provide a meaningful completion that implements or extends the code logically. Write clean, well-typed code.

IMPORTANT: Respond with plain text only. Do not use code blocks, markdown formatting, or backticks. Do not add explanations or comments after the code. Only provide the completed code.`;

        // Get completion from Ollama using full context
        const rawSuggestion = await this.sendToOllama(completionPrompt, temperature, max_tokens);
        
        logger.info(`Raw Ollama response: ${rawSuggestion.substring(0, 200)}${rawSuggestion.length > 200 ? '...' : ''}`);
        
        // Trim the prefix from the response to get just the completion
        let suggestion = rawSuggestion;
        if (rawSuggestion.startsWith(codeBeforeCursor)) {
          suggestion = rawSuggestion.slice(codeBeforeCursor.length);
          logger.info(`Trimmed suggestion: ${suggestion.substring(0, 200)}${suggestion.length > 200 ? '...' : ''}`);
        } else {
          logger.warn(`Response doesn't start with expected prefix: "${codeBeforeCursor}"`);
          logger.warn(`Response starts with: "${rawSuggestion.substring(0, 50)}"`);
        }

        if (stream) {
          // Handle streaming for autocomplete
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });

          const id = `cmpl-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);
          
          // Send the suggestion as a single chunk
          const streamChunk = {
            id,
            object: 'text_completion',
            created,
            model: this.config.ollama.model,
            choices: [{
              text: suggestion,
              index: 0,
              finish_reason: 'stop'
            }]
          };
          
          logger.info(`Sending to VS Code: ${suggestion.substring(0, 200)}${suggestion.length > 200 ? '...' : ''}`);
          res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // Non-streaming response
          const responseObj = {
            id: `cmpl-${Date.now()}`,
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: this.config.ollama.model,
            choices: [{
              text: suggestion,
              index: 0,
              finish_reason: 'stop'
            }]
          };
          
          res.json(responseObj);
        }
        
      } catch (error) {
        logger.error('Error in completion:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // List available tools (placeholder for now)
    this.app.get('/v1/tools', (req, res) => {
      const tools = this.getAvailableTools();
      res.json({ tools });
    });

    // Models endpoint
    this.app.get('/v1/models', (req, res) => {
      res.json({
        object: 'list',
        data: [{
          id: this.config.ollama.model,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'local-mcp-hub',
          capabilities: ['tool_use', 'function_calling'],
          supports_tools: true
        }]
      });
    });
  }

  private convertMessagesToPrompt(messages: any[]): string {
    return messages
      .map(msg => `${msg.role}: ${msg.content}`)
      .join('\n\n');
  }

  private async sendToOllama(prompt: string, temperature: number, maxTokens: number, useFastModel: boolean = false): Promise<string> {
    const model = useFastModel ? this.config.ollama.fast_model : this.config.ollama.model;
    try {
      const response = await fetch(`${this.config.ollama.host}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: temperature,
            num_predict: maxTokens
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      
      if (!data.response) {
        throw new Error('No response from Ollama');
      }

      return data.response;
    } catch (error) {
      logger.error(`Failed to communicate with Ollama (${model}):`, error);
      throw error;
    }
  }

  private async sendToOllamaStreaming(
    prompt: string, 
    temperature: number, 
    maxTokens: number, 
    res: any,
    useFastModel: boolean = false
  ): Promise<void> {
    const model = useFastModel ? this.config.ollama.fast_model : this.config.ollama.model;
    
    try {
      logger.info('🌊 Starting true streaming response from Ollama');
      
      // Set SSE headers immediately
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      });

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      
      const response = await fetch(`${this.config.ollama.host}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          prompt: prompt,
          stream: true, // Enable true streaming
          options: {
            temperature: temperature,
            num_predict: maxTokens
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('No response body from Ollama');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          
          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const data = JSON.parse(line);
                
                if (data.response) {
                  // Send streaming chunk to Continue
                  const streamChunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: model,
                    choices: [{
                      index: 0,
                      delta: { content: data.response },
                      finish_reason: null
                    }]
                  };
                  
                  res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
                  totalTokens++;
                }
                
                if (data.done) {
                  // Send final chunk
                  const finalChunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop'
                    }],
                    usage: {
                      prompt_tokens: this.estimateTokens(prompt),
                      completion_tokens: totalTokens,
                      total_tokens: this.estimateTokens(prompt) + totalTokens
                    }
                  };
                  
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
                  return;
                }
              } catch (e) {
                logger.warn('Failed to parse Ollama streaming response:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      
    } catch (error) {
      logger.error(`Failed to stream from Ollama (${model}):`, error);
      
      // Send error response
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          delta: { content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` },
          finish_reason: 'stop'
        }]
      };
      
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  private sendStreamingResponse(res: any, content: string, model?: string): void {
    // Always send streaming response to Continue
    logger.info('=== SENDING STREAMING RESPONSE TO CONTINUE ===');
    
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    });

    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const responseModel = model || this.config.ollama.model;
    
    logger.info(`Response headers:`, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    });
    logger.info(`Full response content: "${content}"`);
    logger.info(`=== STREAMING CHUNKS START ===`);
    
    // Split response into chunks and send as streaming
    const words = content.split(' ');
    
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
      
      const streamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{
          index: 0,
          delta: { content: chunk },
          finish_reason: null
        }]
      };
      
      const chunkData = `data: ${JSON.stringify(streamChunk)}\n\n`;
      logger.debug(`Chunk ${i}: ${chunkData.trim()}`);
      res.write(chunkData);
    }
    
    // Send final chunk with finish_reason
    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: this.estimateTokens(content),
        completion_tokens: words.length,
        total_tokens: this.estimateTokens(content) + words.length
      }
    };
    
    const finalChunkData = `data: ${JSON.stringify(finalChunk)}\n\n`;
    const doneData = 'data: [DONE]\n\n';
    
    logger.info(`Final chunk: ${finalChunkData.trim()}`);
    logger.info(`Done message: ${doneData.trim()}`);
    logger.info(`=== END STREAMING RESPONSE ===`);
    
    res.write(finalChunkData);
    res.write(doneData);
    res.end();
  }

  private getAvailableTools(): string[] {
    const tools: string[] = [];
    
    // Check which MCPs are enabled and add their tools
    if (this.config.mcps.enabled.includes('serena')) {
      // Serena semantic code tools
      tools.push(
        'list_dir', 'find_file', 'symbol_overview', 'find_symbol',
        'get_symbol_definition', 'list_symbols_in_file', 'find_references',
        'replace_symbol_body', 'search_for_pattern', 'read_file_content',
        'get_workspace_overview', 'search_symbols_in_workspace',
        'get_class_hierarchy', 'find_implementations', 'get_function_calls',
        'analyze_dependencies', 'find_similar_code', 'extract_interfaces'
      );
    }
    
    if (this.config.mcps.enabled.includes('context7')) {
      // Context7 documentation tools
      tools.push('resolve-library-id', 'get-library-docs');
    }
    
    return tools;
  }

  private getOpenAITools(): OpenAITool[] {
    logger.debug(`DEBUG: Getting OpenAI tools, schemasInitialized=${this.schemasInitialized}, schemas.size=${this.mcpToolSchemas.size}`);
    
    // Return cached real MCP schemas with usage guidance if available
    if (this.schemasInitialized && this.mcpToolSchemas.size > 0) {
      const tools = Array.from(this.mcpToolSchemas.values()).map(schema => 
        this.enhanceToolWithUsageGuidance(schema)
      );
      
      logger.debug(`DEBUG: Returning ${tools.length} enhanced tools`);
      logger.debug(`DEBUG: Tool names: ${tools.map(t => t.function.name).join(', ')}`);
      
      // Check if the first tool has usage guidance
      if (tools.length > 0) {
        logger.debug(`DEBUG: First tool enhanced description: ${tools[0].function.description}`);
      }
      
      return tools;
    }
    
    // Fallback to empty array if schemas not loaded yet
    logger.warn('MCP schemas not initialized yet, returning empty tools list');
    return [];
  }

  private enhanceToolWithUsageGuidance(schema: OpenAITool): OpenAITool {
    const guidance = this.getToolUsageGuidance(schema.function.name);
    logger.debug(`DEBUG: Enhancing tool ${schema.function.name}, guidance found: ${guidance ? 'YES' : 'NO'}`);
    
    if (!guidance) return schema;

    const enhanced = {
      ...schema,
      function: {
        ...schema.function,
        description: `${schema.function.description}. ${guidance}`
      }
    };
    
    logger.debug(`DEBUG: Enhanced ${schema.function.name} description: ${enhanced.function.description}`);
    return enhanced;
  }

  private getToolUsageGuidance(toolName: string): string | null {
    const usageMap: Record<string, string> = {
      'list_dir': 'USE WHEN: user asks "what files are in", "list files", "show directory contents", "what\'s in this folder"',
      'find_file': 'USE WHEN: user wants to find specific files by name or pattern like "find *.js files" or "where is config.json"',
      'read_file_content': 'USE WHEN: user wants to see the contents of a specific file',
      'search_for_pattern': 'USE WHEN: user wants to search for code patterns or text within files',
      'get_symbols_overview': 'USE WHEN: user wants to understand the structure/symbols in code files',
      'find_symbol': 'USE WHEN: user is looking for specific functions, classes, or variables in code',
      'replace_symbol_body': 'USE WHEN: user wants to modify/replace specific functions or code blocks',
      'get-library-docs': 'USE WHEN: user asks about documentation for a specific library or framework'
    };
    
    return usageMap[toolName] || null;
  }

  public start(): void {
    const port = process.env.PORT ? parseInt(process.env.PORT) : this.config.hub.port;
    
    // Set up graceful shutdown handlers
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      this.cleanup();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      this.cleanup();
      process.exit(0);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      this.cleanup();
      process.exit(1);
    });
    
    this.app.listen(port, async () => {
      logger.info(`Local MCP Hub started on port ${port}`);
      logger.info(`OpenAI-compatible API available at http://localhost:${port}/v1`);
      logger.info(`Health check: http://localhost:${port}/health`);
      logger.info(`Connected to Ollama at: ${this.config.ollama.host}`);
      
      // Test Ollama connection on startup
      this.testOllamaConnection();
      
      // Initialize MCP tool schemas and keep processes alive
      await this.initializeMCPSchemas();
    });
  }

  private async testOllamaConnection(): Promise<void> {
    try {
      logger.info('Testing connection to remote Ollama...');
      
      // Test main model
      const response = await this.sendToOllama('Hello, this is a connection test.', 0.7, 100, false);
      logger.info(`✓ Main model (${this.config.ollama.model}) connection successful`);
      logger.info(`✓ Response: ${response.substring(0, 100)}...`);
      
      // Test fast model
      const fastResponse = await this.sendToOllama('Test', 0.7, 50, true);
      logger.info(`✓ Fast model (${this.config.ollama.fast_model}) connection successful`);
      logger.info(`✓ Fast response: ${fastResponse.substring(0, 50)}...`);
      
    } catch (error) {
      logger.error('✗ Failed to connect to Ollama:', error);
      logger.error('Please ensure Ollama is running on the remote server and both models are available');
    }
  }

  private estimateTokens(text: string): number {
    // Simple token estimation (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }

  private async initializeMCPSchemas(): Promise<void> {
    logger.info('Initializing MCP tool schemas...');
    
    // Get schemas from each enabled MCP server
    for (const mcpName of this.config.mcps.enabled) {
      try {
        const schemas = await this.getMCPToolSchemas(mcpName);
        schemas.forEach(schema => {
          this.mcpToolSchemas.set(schema.function.name, schema);
        });
        logger.info(`Loaded ${schemas.length} tool schemas from ${mcpName}`);
      } catch (error) {
        logger.error(`Failed to load schemas from ${mcpName}:`, error);
      }
    }
    
    this.schemasInitialized = true;
    logger.info(`Total MCP tools loaded: ${this.mcpToolSchemas.size}`);
  }

  private async getMCPToolSchemas(mcpName: string): Promise<OpenAITool[]> {
    return new Promise((resolve, reject) => {
      let mcpCommand: string;
      let mcpArgs: string[];

      if (mcpName === 'context7') {
        mcpCommand = 'node';
        mcpArgs = [path.join(__dirname, '..', 'mcps', 'context7', 'dist', 'index.js')];
      } else if (mcpName === 'serena') {
        mcpCommand = path.join(__dirname, '..', 'mcps', 'serena', '.venv', 'bin', 'python');
        mcpArgs = [
          path.join(__dirname, '..', 'mcps', 'serena', 'scripts', 'mcp_server.py'),
          '--context', 'ide-assistant',
          '--project', path.join(__dirname, '..'),
          '--transport', 'stdio',
          '--tool-timeout', '30',
          '--log-level', 'WARNING'
        ];
      } else {
        reject(new Error(`Unknown MCP server: ${mcpName}`));
        return;
      }

      const mcpProcess = spawn(mcpCommand, mcpArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.join(__dirname, '..')
      });

      // Store process in pool immediately
      this.mcpProcesses.set(mcpName, mcpProcess);
      this.mcpProcessReady.set(mcpName, false);

      let responseBuffer = '';
      let initialized = false;
      const schemas: OpenAITool[] = [];

      const handleResponse = (data: string) => {
        responseBuffer += data;
        const lines = responseBuffer.split('\n');
        responseBuffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              
              if (response.id === 1 && !initialized) {
                initialized = true;
                logger.debug(`${mcpName} MCP server initialized`);
                
                // Send initialized notification to complete handshake
                const initializedNotification = JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/initialized',
                  params: {}
                });
                mcpProcess.stdin?.write(initializedNotification + '\n');
                logger.debug(`${mcpName} sent initialized notification`);
                
                // Follow proper MCP protocol: send tools/list after initialization
                // For Serena, wait for language server ready signal; for others, send immediately
                if (mcpName !== 'serena') {
                  const toolsRequest = JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list',
                    params: {}
                  });
                  mcpProcess.stdin?.write(toolsRequest + '\n');
                  logger.debug(`${mcpName} sent tools/list request`);
                }
              } else if (response.id === 2 && response.result) {
                // Tools list response - mark process as ready and resolve with schemas
                const tools = response.result.tools || [];
                for (const tool of tools) {
                  schemas.push({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema || {
                        type: 'object',
                        properties: {},
                        required: []
                      }
                    }
                  });
                }
                
                // Mark process as ready for tool calls
                this.mcpProcessReady.set(mcpName, true);
                logger.info(`${mcpName} process initialized and ready for tool calls`);
                resolve(schemas);
                return;
              }
            } catch (e) {
              // Ignore JSON parse errors
            }
          }
        }
      };

      mcpProcess.stdout?.on('data', (data) => {
        handleResponse(data.toString());
      });

      mcpProcess.stderr?.on('data', (data) => {
        const stderr = data.toString();
        logger.debug(`${mcpName} stderr:`, stderr.trim());
        
        // For Serena, wait for language server to be ready before sending tools/list
        if (mcpName === 'serena' && stderr.includes('Language server initialization completed') && initialized) {
          logger.info(`${mcpName} language server ready, sending tools/list`);
          const toolsRequest = JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {}
          });
          mcpProcess.stdin?.write(toolsRequest + '\n');
        }
      });

      mcpProcess.on('close', (code) => {
        logger.warn(`${mcpName} process closed with code ${code}`);
        this.mcpProcesses.delete(mcpName);
        this.mcpProcessReady.delete(mcpName);
        if (schemas.length === 0) {
          reject(new Error(`Failed to get schemas from ${mcpName}`));
        }
      });

      mcpProcess.on('error', (error) => {
        logger.error(`${mcpName} process error:`, error);
        this.mcpProcesses.delete(mcpName);
        this.mcpProcessReady.delete(mcpName);
        reject(error);
      });

      // Initialize
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          clientInfo: { name: 'local-mcp-hub', version: '1.0.0' }
        }
      });

      mcpProcess.stdin?.write(initRequest + '\n');

      // Timeout
      setTimeout(() => {
        if (!this.mcpProcessReady.get(mcpName)) {
          logger.error(`${mcpName} initialization timeout`);
          mcpProcess.kill();
          this.mcpProcesses.delete(mcpName);
          this.mcpProcessReady.delete(mcpName);
          reject(new Error(`Timeout getting schemas from ${mcpName}`));
        }
      }, 30000);
    });
  }

  private async callMCPTool(toolName: string, args: any = {}): Promise<string> {
    // Determine which MCP server to use based on tool name
    let mcpName: string;
    if (toolName.includes('resolve-library-id') || toolName.includes('get-library-docs')) {
      mcpName = 'context7';
    } else {
      mcpName = 'serena';
    }

    // Check if we have a ready process for this MCP server
    const process = this.mcpProcesses.get(mcpName);
    const isReady = this.mcpProcessReady.get(mcpName);

    if (!process || !isReady) {
      throw new Error(`MCP server ${mcpName} is not available or not ready`);
    }

    return new Promise((resolve, reject) => {
      const callStartTime = Date.now();
      let responseBuffer = '';
      let toolCallId = Date.now(); // Use timestamp as unique ID

      const handleResponse = (data: string) => {
        responseBuffer += data;
        const lines = responseBuffer.split('\n');
        
        // Keep the last incomplete line in buffer
        responseBuffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              logger.debug(`${mcpName} Response:`, response);
              
              // Look for our tool call response
              if (response.id === toolCallId) {
                logger.info(`⏱️ TIMING: MCP tool call completed in ${Date.now() - callStartTime}ms`);
                
                if (response.result) {
                  // Extract the actual result data from MCP response structure
                  let resultData = 'Tool executed successfully';
                  
                  if (response.result.structuredContent && response.result.structuredContent.result) {
                    resultData = response.result.structuredContent.result;
                  } else if (response.result.content && response.result.content.length > 0) {
                    resultData = response.result.content[0].text || JSON.stringify(response.result.content);
                  } else {
                    resultData = JSON.stringify(response.result);
                  }
                  
                  logger.debug('Extracted tool result:', resultData);
                  cleanup();
                  resolve(resultData);
                } else if (response.error) {
                  cleanup();
                  reject(new Error(`MCP tool error: ${response.error.message}`));
                } else {
                  cleanup();
                  resolve('Tool executed successfully');
                }
                return;
              }
            } catch (e) {
              logger.warn('Failed to parse MCP response:', line);
            }
          }
        }
      };

      let cleanup = () => {
        process.stdout?.off('data', handleResponse);
        process.stderr?.off('data', errorHandler);
      };

      const errorHandler = (data: Buffer) => {
        logger.debug(`${mcpName} stderr:`, data.toString());
      };

      // Set up event listeners
      process.stdout?.on('data', handleResponse);
      process.stderr?.on('data', errorHandler);

      // Send tool call request directly (no initialization needed - process is already ready)
      const toolCallRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: toolCallId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      });

      logger.info('📤 SENDING MCP TOOL CALL REQUEST:');
      logger.info(`📝 Request JSON: ${toolCallRequest}`);
      logger.info(`🔧 Tool name: ${toolName}`);
      logger.info(`📋 Args object: ${JSON.stringify(args, null, 2)}`);
      
      try {
        process.stdin?.write(toolCallRequest + '\n');
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to send tool call to ${mcpName}: ${error}`));
        return;
      }

      // Timeout for this specific tool call
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Tool call timeout for ${toolName}`));
      }, 30000);

      // Wrap cleanup and timeout clearing
      const originalCleanup = cleanup;
      cleanup = () => {
        clearTimeout(timeout);
        originalCleanup();
      };
    });
  }

  private async enhancePromptWithTools(prompt: string): Promise<string> {
    // Simple heuristic to determine if we should use tools
    const needsCodeAnalysis = prompt.toLowerCase().includes('class') || 
                             prompt.toLowerCase().includes('method') || 
                             prompt.toLowerCase().includes('function') ||
                             prompt.toLowerCase().includes('code') ||
                             prompt.toLowerCase().includes('file');

    if (needsCodeAnalysis) {
      try {
        // For now, use simple file reading instead of full MCP protocol
        logger.info('Attempting to provide code context...');
        
        const srcPath = path.join(__dirname, '..', 'src');
        const hubFilePath = path.join(srcPath, 'hub.ts');
        
        // Read the main hub file if it exists
        if (fs.existsSync(hubFilePath)) {
          const hubContent = fs.readFileSync(hubFilePath, 'utf-8');
          const codeContext = `
Local codebase analysis:
- Main file: src/hub.ts
- Contains LocalMCPHub class
- Key methods: ${this.extractMethodNames(hubContent)}
- File structure: ${fs.readdirSync(srcPath).join(', ')}

Hub.ts content (first 1000 chars):
${hubContent.substring(0, 1000)}...
`;
          
          return `${prompt}\n\n${codeContext}`;
        }
        
        return prompt;
      } catch (error) {
        logger.warn('Failed to get code context, continuing without tools:', error);
        return prompt;
      }
    }

    return prompt;
  }

  private extractMethodNames(code: string): string[] {
    // Simple regex to extract method names
    const methodRegex = /(?:private|public|async)?\s*([\w]+)\s*\([^)]*\)\s*[:{]/g;
    const methods: string[] = [];
    let match;
    
    while ((match = methodRegex.exec(code)) !== null) {
      if (match[1] && !['if', 'for', 'while', 'switch'].includes(match[1])) {
        methods.push(match[1]);
      }
    }
    
    return methods.slice(0, 10); // Limit to first 10 methods
  }

  private cleanup(): void {
    logger.info('Cleaning up MCP processes...');
    for (const [mcpName, process] of this.mcpProcesses) {
      try {
        logger.info(`Terminating ${mcpName} process`);
        process.kill('SIGTERM');
      } catch (error) {
        logger.warn(`Failed to terminate ${mcpName} process:`, error);
      }
    }
    this.mcpProcesses.clear();
    this.mcpProcessReady.clear();
  }

  private async selectToolWithLLM(messages: any[], tools: OpenAITool[]): Promise<{tool: string, args: any} | null> {
    const lastMessage = messages[messages.length - 1];
    const userRequest = lastMessage.content;
    
    logger.debug(`DEBUG: User request: "${userRequest}"`);
    logger.debug(`DEBUG: Number of tools: ${tools.length}`);
    
    // Stage 1: Select the tool using only names and USE WHEN descriptions
    const toolNames = tools.map(tool => {
      const guidance = this.getToolUsageGuidance(tool.function.name);
      const shortDesc = tool.function.description.split('.')[0]; // Take first sentence only
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
    
    logger.debug(`DEBUG: Stage 1 prompt length: ${toolSelectionPrompt.length} chars`);
    
    try {
      // Stage 1: Select the tool using fast model
      const stage1StartTime = Date.now();
      const toolResponse = await this.sendToOllama(toolSelectionPrompt, 0.1, 100, true);
      logger.info(`⏱️ TIMING: Stage 1 tool selection (fast model) completed in ${Date.now() - stage1StartTime}ms`);
      const cleanToolResponse = toolResponse.trim().replace(/```json|```/g, '').trim();
      
      logger.debug(`DEBUG: Stage 1 response: "${cleanToolResponse}"`);
      
      const toolSelection = JSON.parse(cleanToolResponse);
      
      if (!toolSelection.tool || toolSelection.tool === null) {
        logger.info('No tool selected by LLM');
        return null;
      }
      
      // Find the selected tool
      const selectedTool = tools.find(t => t.function.name === toolSelection.tool);
      if (!selectedTool) {
        logger.warn(`LLM selected non-existent tool: ${toolSelection.tool}`);
        return null;
      }
      
      logger.info(`Stage 1: LLM selected tool: ${toolSelection.tool}`);
      
      // Stage 2: Generate arguments using smart model selection
      const stage2StartTime = Date.now();
      let argsSelection;
      
      if (this.isSimpleArgumentGeneration(toolSelection.tool)) {
        logger.info(`🏃 Using fast model for simple argument generation: ${toolSelection.tool}`);
        argsSelection = await this.generateArgsWithFastModel(userRequest, selectedTool);
      } else {
        logger.info(`🧠 Using full model for complex argument generation: ${toolSelection.tool}`);
        argsSelection = await this.generateArgsWithFullModel(userRequest, selectedTool);
      }
      
      const modelType = this.isSimpleArgumentGeneration(toolSelection.tool) ? 'fast model' : 'full model';
      logger.info(`⏱️ TIMING: Stage 2 argument generation (${modelType}) completed in ${Date.now() - stage2StartTime}ms`);
      logger.info(`Stage 2: Generated args: ${JSON.stringify(argsSelection.args)}`);
      
      return { 
        tool: toolSelection.tool, 
        args: argsSelection.args || {} 
      };
      
    } catch (error) {
      logger.error('Error in two-stage tool selection:', error);
      return null;
    }
  }


  private isSafeTool(toolName: string): boolean {
    // Define safe read-only tools that can be auto-executed
    const safeTools = [
      'read_file_content',      // Read file contents
      'list_dir',               // List directory contents  
      'find_file',              // Find files matching pattern
      'search_for_pattern',     // Search for code patterns
      'get_workspace_overview', // Get workspace structure
      'symbol_overview',        // Get symbol overview
      'find_symbol',            // Find specific symbols
      'get_symbol_definition',  // Get symbol definitions
      'list_symbols_in_file',   // List symbols in file
      'find_references',        // Find symbol references
      'search_symbols_in_workspace', // Search symbols across workspace
      'get_class_hierarchy',    // Get class inheritance
      'find_implementations',   // Find interface implementations
      'get_function_calls',     // Get function call graphs
      'analyze_dependencies',   // Analyze code dependencies
      'find_similar_code',      // Find similar code patterns
      'extract_interfaces',     // Extract interface definitions
      'resolve-library-id',     // Resolve library name to Context7 ID
      'get-library-docs'        // Fetch library documentation
    ];
    
    return safeTools.includes(toolName);
  }

  private isSimpleArgumentGeneration(toolName: string): boolean {
    // Explicit whitelist of tools with predictable, simple arguments
    const SIMPLE_TOOLS = [
      'list_dir',               // Always: relative_path + recursive boolean
      'find_file',              // Always: file_mask + relative_path  
      'read_file_content',      // Always: just relative_path
      'write_memory',           // Simple: key + content
      'read_memory',            // Simple: just key
      'list_memories',          // Simple: no arguments or basic filtering
      'delete_memory',          // Simple: just key
      'get_current_config',     // Simple: no arguments
      'restart_language_server', // Simple: no/minimal arguments
      'get_symbols_overview',   // Simple: relative_path parameter only
      'activate_project',       // Simple: project path
      'remove_project',         // Simple: project path
      'resolve-library-id',     // Simple: library name string
      'get-library-docs'        // Simple: library ID string (after resolve)
    ];
    
    return SIMPLE_TOOLS.includes(toolName);
  }

  private requiresComplexReasoning(toolName: string): boolean {
    // Explicit blacklist of tools requiring sophisticated reasoning
    const COMPLEX_REASONING_TOOLS = [
      'search_for_pattern',       // Regex generation + file filtering logic
      'replace_regex',            // Regex replacement patterns  
      'find_symbol',              // Symbol path matching rules + depth decisions
      'find_referencing_symbols', // Symbol relationship analysis
      'replace_symbol_body',      // Code structure understanding + replacement logic
      'insert_after_symbol',      // Code insertion positioning logic
      'insert_before_symbol',     // Code insertion positioning logic
      'switch_modes',             // Complex mode switching logic
      'onboarding',               // Multi-step process logic
      'think_about_collected_information', // Complex reasoning tasks
      'think_about_task_adherence',        // Complex reasoning tasks  
      'think_about_whether_you_are_done',  // Complex reasoning tasks
      'summarize_changes',        // Complex analysis and summarization
      'prepare_for_new_conversation', // Complex state management
      'initial_instructions'      // Complex initialization logic
    ];
    
    return COMPLEX_REASONING_TOOLS.includes(toolName);
  }

  private async generateArgsWithFastModel(userRequest: string, toolSchema: OpenAITool): Promise<any> {
    const params = Object.entries(toolSchema.function.parameters.properties || {})
      .map(([name, schema]: [string, any]) => `- ${name} (${schema.type}): ${schema.description || 'No description'}`)
      .join('\n');
    
    // Simplified prompt for fast model - focus on pattern recognition
    const argsPrompt = `Generate tool arguments from user request.

Tool: ${toolSchema.function.name}
User request: "${userRequest}"

Parameters:
${params}

Common patterns:
- For directory operations: use "." for current directory
- For file operations: extract filename/pattern from request
- For boolean flags: true if mentioned (recursive, etc.)

Respond ONLY with JSON: {"args": {"param": "value"}}

Response:`;
    
    logger.debug(`DEBUG: Fast model Stage 2 prompt length: ${argsPrompt.length} chars`);

    const argsResponse = await this.sendToOllama(argsPrompt, 0.1, 100, true); // Use fast model
    const cleanArgsResponse = argsResponse.trim().replace(/```json|```/g, '').trim();
    
    logger.debug(`DEBUG: Fast model Stage 2 response: "${cleanArgsResponse}"`);

    return JSON.parse(cleanArgsResponse);
  }

  private async generateArgsWithFullModel(userRequest: string, toolSchema: OpenAITool): Promise<any> {
    const params = Object.entries(toolSchema.function.parameters.properties || {})
      .map(([name, schema]: [string, any]) => `- ${name} (${schema.type}): ${schema.description || 'No description'}`)
      .join('\n');
      
    // Detailed prompt for full model - comprehensive reasoning
    const argsPrompt = `You are a helpful assistant that generates tool arguments.

User request: "${userRequest}"
Selected tool: ${toolSchema.function.name}

Tool description: ${toolSchema.function.description}

Parameters:
${params}

INSTRUCTIONS:
1. Extract arguments from the user's request based on the tool's parameter requirements
2. Use relative paths (e.g., "." for current directory) and appropriate boolean values
3. For complex tools, carefully consider parameter relationships and validation
4. Respond with: {"args": {"param1": "value1", "param2": "value2"}}

RESPOND WITH ONLY THE JSON, NO OTHER TEXT.

Response:`;
    
    logger.debug(`DEBUG: Full model Stage 2 prompt length: ${argsPrompt.length} chars`);
    
    const argsResponse = await this.sendToOllama(argsPrompt, 0.1, 150, false); // Use full model
    const cleanArgsResponse = argsResponse.trim().replace(/```json|```/g, '').trim();
    
    logger.debug(`DEBUG: Full model Stage 2 response: "${cleanArgsResponse}"`);
    
    return JSON.parse(cleanArgsResponse);
  }

  private async generateResponseWithToolResults(
    messages: any[], 
    temperature: number, 
    maxTokens: number
  ): Promise<string> {
    // Find the tool results in the messages
    const toolResults = messages.filter(msg => msg.role === 'tool');
    const userMessages = messages.filter(msg => msg.role !== 'tool');
    
    // Create a prompt that includes the tool results
    let prompt = this.convertMessagesToPrompt(userMessages);
    
    if (toolResults.length > 0) {
      prompt += '\n\nTool Results:\n';
      toolResults.forEach((result, index) => {
        prompt += `Result ${index + 1}: ${result.content}\n`;
      });
      prompt += '\nBased on the tool results above, provide a helpful and accurate response to the user. Summarize the information clearly and answer their question.';
    }
    
    return await this.sendToOllama(prompt, temperature, maxTokens);
  }

  private async generateResponseWithToolResultsStreaming(
    messages: any[], 
    temperature: number, 
    maxTokens: number,
    res: any
  ): Promise<void> {
    // Find the tool results in the messages
    const toolResults = messages.filter(msg => msg.role === 'tool');
    const userMessages = messages.filter(msg => msg.role !== 'tool');
    
    // Create a prompt that includes the tool results
    let prompt = this.convertMessagesToPrompt(userMessages);
    
    if (toolResults.length > 0) {
      prompt += '\n\nTool Results:\n';
      toolResults.forEach((result, index) => {
        prompt += `Result ${index + 1}: ${result.content}\n`;
      });
      prompt += '\nBased on the tool results above, provide a helpful and accurate response to the user. Summarize the information clearly and answer their question.';
    }
    
    await this.sendToOllamaStreaming(prompt, temperature, maxTokens, res);
  }

  // Completion handler methods
  private parseFIMRequest(prompt: string): FIMRequest {
    // Check if this is a FIM (Fill-In-Middle) request
    if (!prompt.includes('<fim_prefix>') || !prompt.includes('<fim_suffix>')) {
      return { prefix: prompt, suffix: '', isFIM: false };
    }

    // Find the last occurrence of the FIM pattern to handle embedded content correctly
    const lastFimSuffixIndex = prompt.lastIndexOf('<fim_suffix>');
    const lastFimMiddleIndex = prompt.lastIndexOf('<fim_middle>');
    
    if (lastFimSuffixIndex === -1 || lastFimMiddleIndex === -1) {
      return { prefix: prompt, suffix: '', isFIM: false };
    }
    
    // Extract prefix (everything between <fim_prefix> and the last <fim_suffix>)
    const prefixStart = prompt.indexOf('<fim_prefix>') + '<fim_prefix>'.length;
    const prefix = prompt.substring(prefixStart, lastFimSuffixIndex);
    
    // Extract suffix (everything between the last <fim_suffix> and <fim_middle>)
    const suffixStart = lastFimSuffixIndex + '<fim_suffix>'.length;
    const suffix = prompt.substring(suffixStart, lastFimMiddleIndex);
    
    return { prefix, suffix, isFIM: true };
  }
}

// Start the hub
if (require.main === module) {
  const hub = new LocalMCPHub();
  hub.start();
}

export { LocalMCPHub };