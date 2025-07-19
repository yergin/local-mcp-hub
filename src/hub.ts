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
        mcps_enabled: this.config.mcps.enabled.length
      });
    });

    // OpenAI-compatible chat completions
    this.app.post('/v1/chat/completions', async (req, res) => {
      try {
        logger.info('Received chat completion request');
        logger.debug('Request body:', JSON.stringify(req.body, null, 2));
        
        const { messages, model, temperature = 0.7, max_tokens = 4000, stream = false } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: 'Invalid messages format' });
        }

        // Convert OpenAI messages to Ollama format
        const basePrompt = this.convertMessagesToPrompt(messages);
        
        // Enhance prompt with MCP tools if needed
        const prompt = await this.enhancePromptWithTools(basePrompt);
        
        if (stream) {
          // Set headers for Server-Sent Events
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type'
          });

          const id = `chatcmpl-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);
          
          try {
            const response = await this.sendToOllama(prompt, temperature, max_tokens);
            
            // Split response into chunks and send as streaming
            const words = response.split(' ');
            
            for (let i = 0; i < words.length; i++) {
              const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
              
              const streamChunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: this.config.ollama.model,
                choices: [{
                  index: 0,
                  delta: { content: chunk },
                  finish_reason: null
                }]
              };
              
              res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
              
              // Small delay to simulate streaming
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            // Send final chunk with finish_reason
            const finalChunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: this.config.ollama.model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }],
              usage: {
                prompt_tokens: this.estimateTokens(prompt),
                completion_tokens: this.estimateTokens(response),
                total_tokens: this.estimateTokens(prompt) + this.estimateTokens(response)
              }
            };
            
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            
          } catch (error) {
            logger.error('Error in streaming completion:', error);
            const errorChunk = {
              error: {
                type: 'internal_server_error',
                code: 'streaming_failed',
                message: error instanceof Error ? error.message : 'Unknown error'
              }
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.end();
          }
        } else {
          // Non-streaming response
          const response = await this.sendToOllama(prompt, temperature, max_tokens);
          
          // Convert back to OpenAI format
          const openaiResponse = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: this.config.ollama.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: response
              },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: prompt.length,
              completion_tokens: response.length,
              total_tokens: prompt.length + response.length
            }
          };

          res.json(openaiResponse);
        }
        
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
        const { prompt, max_tokens = 50, temperature = 0.1, stream = false } = req.body;
        
        if (!prompt) {
          return res.status(400).json({ error: 'Prompt is required' });
        }

        // Parse FIM request and create context-aware completion
        
        const fimRequest = this.parseFIMRequest(prompt);
        
        // Extract the immediate code before cursor (last line)
        const lines = fimRequest.prefix.split('\n');
        const codeBeforeCursor = lines[lines.length - 1] || '';
        const projectContext = lines.slice(0, -1).join('\n');

        // Create context-aware completion prompt
        const completionPrompt = `You are a code completion assistant. Complete the code at the cursor position. Do not add explanations and respond in plain text starting with the code said to be shown before the cursor character-for-character as your text will replace the code directly.

PROJECT CONTEXT (only provided for you to quickly guess the language/framework):
${projectContext}

CODE IMMEDIATELY BEFORE CURSOR:
${codeBeforeCursor}

CODE AFTER CURSOR (suffix):
${fimRequest.suffix}

TASK: Complete the code making sure to include the suffix "${fimRequest.suffix}" and continue beyond it with appropriate code completion as you see fit.

COMPLETION:`;

        // Get completion from Ollama using full context
        const rawSuggestion = await this.sendToOllama(completionPrompt, temperature, Math.min(max_tokens, 150));
        
        // Trim the prefix from the response to get just the completion
        let suggestion = rawSuggestion;
        if (rawSuggestion.startsWith(codeBeforeCursor)) {
          suggestion = rawSuggestion.slice(codeBeforeCursor.length);
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
          owned_by: 'local-mcp-hub'
        }]
      });
    });
  }

  private convertMessagesToPrompt(messages: any[]): string {
    return messages
      .map(msg => `${msg.role}: ${msg.content}`)
      .join('\n\n');
  }

  private async sendToOllama(prompt: string, temperature: number, maxTokens: number): Promise<string> {
    try {
      const response = await fetch(`${this.config.ollama.host}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ollama.model,
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
      logger.error('Failed to communicate with Ollama:', error);
      throw error;
    }
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

  public start(): void {
    const port = process.env.PORT ? parseInt(process.env.PORT) : this.config.hub.port;
    
    this.app.listen(port, () => {
      logger.info(`Local MCP Hub started on port ${port}`);
      logger.info(`OpenAI-compatible API available at http://localhost:${port}/v1`);
      logger.info(`Health check: http://localhost:${port}/health`);
      logger.info(`Connected to Ollama at: ${this.config.ollama.host}`);
      
      // Test Ollama connection on startup
      this.testOllamaConnection();
    });
  }

  private async testOllamaConnection(): Promise<void> {
    try {
      logger.info('Testing connection to remote Ollama...');
      const response = await this.sendToOllama('Hello, this is a connection test.', 0.7, 100);
      logger.info('✓ Ollama connection successful');
      logger.info(`✓ Response: ${response.substring(0, 100)}...`);
    } catch (error) {
      logger.error('✗ Failed to connect to Ollama:', error);
      logger.error('Please ensure Ollama is running on the remote server');
    }
  }

  private estimateTokens(text: string): number {
    // Simple token estimation (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }

  private async callMCPTool(toolName: string, args: any = {}): Promise<string> {
    // Determine which MCP server to use based on tool name
    let mcpCommand: string;
    let mcpArgs: string[];

    if (toolName.includes('resolve-library-id') || toolName.includes('get-library-docs')) {
      // Context7 tool
      mcpCommand = 'node';
      mcpArgs = [path.join(__dirname, '..', 'mcps', 'context7', 'dist', 'index.js')];
    } else {
      // Serena tool - handle Windows vs Unix paths
      const isWindows = process.platform === 'win32';
      const venvDir = isWindows ? 'Scripts' : 'bin';
      const executable = isWindows ? 'serena-mcp-server.exe' : 'serena-mcp-server';
      
      mcpCommand = path.join(__dirname, '..', 'mcps', 'serena', '.venv', venvDir, executable);
      mcpArgs = [
        '--context', 'ide-assistant',
        '--project', path.join(__dirname, '..'),
        '--transport', 'stdio',
        '--tool-timeout', '30',
        '--log-level', 'WARNING'
      ];
    }

    return new Promise((resolve, reject) => {
      const process = spawn(mcpCommand, mcpArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.join(__dirname, '..')
      });

      let output = '';
      let errorOutput = '';

      process.stdout?.on('data', (data) => {
        output += data.toString();
      });

      process.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`MCP tool failed: ${errorOutput}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });

      // Send tool request (simplified for now)
      const toolRequest = JSON.stringify({
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      });

      process.stdin?.write(toolRequest + '\n');
      process.stdin?.end();

      // Timeout after 30 seconds
      setTimeout(() => {
        process.kill();
        reject(new Error('MCP tool timeout'));
      }, 30000);
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

  // Completion handler methods
  private parseFIMRequest(prompt: string): FIMRequest {
    // Check if this is a FIM (Fill-In-Middle) request
    if (!prompt.includes('<fim_prefix>') || !prompt.includes('<fim_suffix>')) {
      return { prefix: prompt, suffix: '', isFIM: false };
    }

    // Extract the prefix and suffix from the FIM format
    const prefixMatch = prompt.match(/<fim_prefix>(.*?)<fim_suffix>/s);
    const suffixMatch = prompt.match(/<fim_suffix>(.*?)<fim_middle>/s);
    
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const suffix = suffixMatch ? suffixMatch[1] : '';
    
    return { prefix, suffix, isFIM: true };
  }

  private createCompletionContext(prefix: string, suffix: string): CompletionContext {
    // Clean up the prefix to get actual code context
    const lines = prefix.split('\n');
    const codeLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//') && !trimmed.startsWith('Path:');
    });
    const cleanPrefix = codeLines.slice(-8).join('\n'); // Last 8 lines of actual code
    
    return { prefix, suffix, cleanPrefix };
  }

  private createCompletionPrompt(context: CompletionContext): string {
    const { cleanPrefix, suffix } = context;
    return `<PRE> ${cleanPrefix} <SUF>${suffix} <MID>`;
  }
}

// Start the hub
if (require.main === module) {
  const hub = new LocalMCPHub();
  hub.start();
}

export { LocalMCPHub };