import express from 'express';
import cors from 'cors';
import winston from 'winston';
import fs from 'fs';
import path from 'path';

import { OllamaClient, OllamaConfig } from './ollama-client';
import { MCPManager, MCPConfig, OpenAITool } from './mcp-manager';
import {
  ToolSelector,
  ToolGuidanceConfig,
  ToolSelectionConfig,
  ArgumentGenerationConfig,
} from './tool-selector';
import { RequestProcessor, ResponseGenerationConfig } from './request-processor';

// Prompts configuration interfaces
interface PromptConfig {
  message?: string;
  template?: string;
  temperature: number;
  maxTokens: number;
  useFastModel: boolean;
}

interface PromptsConfig {
  connectionTest: {
    main: PromptConfig;
    fast: PromptConfig;
  };
  toolSelection: {
    stage1: PromptConfig;
  };
  argumentGeneration: {
    fastModel: PromptConfig;
    fullModel: PromptConfig;
  };
  codeCompletion: {
    completion: PromptConfig;
  };
  toolGuidance?: {
    usageHints?: Record<string, string>;
    fastModelTools?: string[];
    safeTools?: string[];
  };
  responseGeneration?: {
    toolResultsStreaming?: { template?: string };
    toolResultsNonStreaming?: { template?: string };
  };
  systemMessages?: {
    mcpInitializing?: { template?: string };
    toolPermissionError?: { template?: string };
    toolPermissionRequest?: { template?: string };
  };
}

// Configuration interface
interface Config {
  ollama: OllamaConfig;
  hub: {
    port: number;
    log_level?: string;
    cors_origins: string[];
  };
  mcps: MCPConfig;
}

// Helper function for temp directory path (used before class instantiation)
const getTmpPath = (...segments: string[]): string => {
  return path.join(__dirname, '..', '.tmp', ...segments);
};

// Ensure .tmp directory exists for logs
const tmpDir = getTmpPath();
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Logger setup with standardized formatting
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${timestamp} [${level}] ${message}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: getTmpPath('local-mcp-hub.log'),
      format: winston.format.json(),
    }),
  ],
});

// Helper functions for consistent logging
const logTiming = (operation: string, startTime: number, metadata?: object) => {
  const duration = Date.now() - startTime;
  logger.info(`Timing: ${operation} completed`, { duration: `${duration}ms`, ...metadata });
};

const logMCPRequest = (mcpName: string, method: string, params: any) => {
  logger.debug(`MCP ${mcpName}: ${method}`, { params });
};

const logMCPResponse = (mcpName: string, method: string, success: boolean, data?: any) => {
  const level = success ? 'debug' : 'error';
  logger[level](`MCP ${mcpName}: ${method} ${success ? 'succeeded' : 'failed'}`, { data });
};

class LocalMCPHub {
  private app: express.Application;
  private config: Config;
  private prompts: PromptsConfig;
  private ollamaClient: OllamaClient;
  private mcpManager: MCPManager;
  private toolSelector: ToolSelector;
  private requestProcessor: RequestProcessor;

  constructor() {
    this.app = express();
    this.config = this.loadConfig();
    this.prompts = this.loadPrompts();
    this.ensureTmpDirectory();

    // Initialize extracted classes
    this.ollamaClient = new OllamaClient(this.config.ollama, logger);
    this.mcpManager = new MCPManager(this.config.mcps, logger);
    this.toolSelector = new ToolSelector(
      this.ollamaClient,
      this.prompts.toolGuidance || {},
      this.prompts.toolSelection as any,
      this.prompts.argumentGeneration as any,
      logger
    );
    this.requestProcessor = new RequestProcessor(
      this.ollamaClient,
      this.prompts.responseGeneration || {},
      logger
    );

    this.setupMiddleware();
    this.setupRoutes();
  }

  private loadConfig(): Config {
    try {
      const configPath = path.join(__dirname, '..', 'config.json');
      const configData = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData) as Config;

      // Update logger level based on config and environment variable
      const logLevel = config.hub.log_level || process.env.LOG_LEVEL || 'info';
      logger.level = logLevel;

      logger.info('Configuration loaded', {
        ollamaHost: config.ollama.host,
        port: config.hub.port,
        logLevel: logLevel,
      });
      return config;
    } catch (error) {
      logger.error('Failed to load configuration:', error);
      process.exit(1);
    }
  }

  private loadPrompts(): PromptsConfig {
    try {
      const promptsPath = path.join(__dirname, '..', 'prompts.json');
      const promptsData = fs.readFileSync(promptsPath, 'utf-8');
      const prompts = JSON.parse(promptsData) as PromptsConfig;
      logger.info('Prompts configuration loaded');
      return prompts;
    } catch (error) {
      logger.error('Failed to load prompts configuration:', error);
      process.exit(1);
    }
  }

  private getTmpPath(...segments: string[]): string {
    return path.join(__dirname, '..', '.tmp', ...segments);
  }

  private ensureTmpDirectory(): void {
    const tmpDir = this.getTmpPath();
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
      logger.debug('Created .tmp directory for debugging files');
    }
  }

  private setupMiddleware(): void {
    // Enhanced CORS configuration for Continue extension compatibility
    this.app.use(
      cors({
        origin: this.config.hub.cors_origins || ['*'],
        credentials: true,
        allowedHeaders: [
          'Authorization',
          'Content-Type',
          'Accept',
          'Origin',
          'X-Requested-With',
          'Cache-Control',
        ],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        exposedHeaders: ['Content-Type', 'Cache-Control', 'Connection'],
      })
    );

    // Additional CORS headers for streaming
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, Origin, X-Requested-With, Cache-Control'
      );
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
      // Single consolidated HTTP request log
      logger.info('HTTP request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        hasAuth: !!req.headers.authorization,
      });
      
      // Debug logging: Complete HTTP request details
      logger.debug('HTTP REQUEST DETAILS', {
        method: req.method,
        url: req.url,
        path: req.path,
        query: req.query,
        headers: req.headers,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        contentType: req.get('Content-Type'),
        contentLength: req.get('Content-Length'),
        hasBody: req.method === 'POST' || req.method === 'PUT'
      });
      
      // Intercept response for logging (only once per request)
      if (!res.locals.logInterceptorApplied) {
        res.locals.logInterceptorApplied = true;
        
        const originalSend = res.send;
        const originalJson = res.json;
        
        res.send = function(body) {
          logger.debug('HTTP RESPONSE (SEND)', {
            statusCode: res.statusCode,
            path: req.path,
            method: req.method,
            responseHeaders: res.getHeaders(),
            bodyLength: typeof body === 'string' ? body.length : 0,
            bodyPreview: typeof body === 'string' ? body.substring(0, 200) + '...' : 'non-string body'
          });
          return originalSend.call(this, body);
        };
        
        res.json = function(obj) {
          logger.debug('HTTP RESPONSE (JSON)', {
            statusCode: res.statusCode,
            path: req.path,
            method: req.method,
            responseHeaders: res.getHeaders(),
            responseBodyType: typeof obj,
            responseBodySize: JSON.stringify(obj).length
          });
          return originalJson.call(this, obj);
        };
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
        mcp_tools_initialized: this.mcpManager.isInitialized,
        mcp_tools_count: this.mcpManager.toolCount,
      });
    });

    // OpenAI-compatible chat completions
    this.app.post('/v1/chat/completions', async (req, res) => {
      const startTime = Date.now();
      try {
        logger.info('Chat completion request received');
        logger.debug('CHAT COMPLETION REQUEST BODY', {
          fullRequestBody: req.body,
          messagesCount: req.body.messages?.length || 0,
          hasTools: !!(req.body.tools && req.body.tools.length > 0),
          toolsCount: req.body.tools?.length || 0
        });

        const {
          messages,
          model,
          temperature = 0.7,
          max_tokens = 4000,
          stream = false,
          tools,
          tool_choice,
        } = req.body;

        if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: 'Invalid messages format' });
        }

        // Check if this is a tool call response (messages contain tool results)
        const hasToolResults = messages.some(msg => msg.role === 'tool');

        if (hasToolResults) {
          // Generate final response using tool results
          const response = await this.requestProcessor.generateResponseWithToolResults(
            messages,
            temperature,
            max_tokens
          );
          this.requestProcessor.sendStreamingResponse(res, response, this.config.ollama.model);
          return;
        }

        // Check if tools are available and replace with our MCP tools
        if (tools && tools.length > 0) {
          logger.info(`Tools received from Continue: ${tools.length} tools found`);
          logger.debug(
            'Continue tools:',
            tools.map((t: OpenAITool) => t.function.name)
          );

          // Check if MCP tools are initialized yet
          if (!this.mcpManager.isInitialized) {
            logger.warn('MCP tools not yet initialized, sending initialization message');
            const initMessage = this.prompts.systemMessages!.mcpInitializing!.template!.replace(
              '{port}',
              this.config.hub.port.toString()
            );

            this.requestProcessor.sendStreamingResponse(res, initMessage, this.config.ollama.model);
            return;
          }

          // Replace Continue's tools with our MCP tools
          const toolsStartTime = Date.now();
          const mcpTools = this.mcpManager
            .getOpenAITools()
            .map(tool => this.toolSelector.enhanceToolWithUsageGuidance(tool));
          logTiming('MCP tools retrieval', toolsStartTime, { toolCount: mcpTools.length });
          logger.debug('Available MCP tools', {
            tools: mcpTools.map((t: OpenAITool) => t.function.name),
          });

          const selectionStartTime = Date.now();
          const toolSelection = await this.toolSelector.selectToolWithLLM(messages, mcpTools);
          logTiming('Tool selection', selectionStartTime);
          logger.info('Tool selected', {
            tool: toolSelection?.tool,
            hasArgs: !!toolSelection?.args,
          });

          if (toolSelection) {
            logger.info(`Processing tool selection: ${toolSelection.tool}`);

            // Check if this is a safe tool that can be auto-executed
            if (this.toolSelector.isSafeTool(toolSelection.tool)) {
              logger.info(`Auto-executing safe tool: ${toolSelection.tool}`);

              try {
                // Execute the tool automatically
                const toolExecStartTime = Date.now();
                const toolResult = await this.mcpManager.callMCPTool(
                  toolSelection.tool,
                  toolSelection.args
                );
                logTiming(`Tool execution: ${toolSelection.tool}`, toolExecStartTime);
                logger.info('Tool executed successfully', { resultLength: toolResult.length });

                // Create messages with tool result for final response
                const messagesWithTool = [
                  ...messages,
                  {
                    role: 'assistant',
                    content: `I'll use the ${toolSelection.tool} tool to help answer your question.`,
                  },
                  {
                    role: 'tool',
                    content: toolResult,
                    name: toolSelection.tool,
                  },
                ];

                const finalResponseStartTime = Date.now();
                logger.info('Starting streaming final response generation');
                await this.requestProcessor.generateResponseWithToolResultsStreaming(
                  messagesWithTool,
                  temperature,
                  max_tokens,
                  res
                );
                logTiming('Final response generation', finalResponseStartTime);

                logTiming('Total chat completion request', startTime);
                return;
              } catch (toolError) {
                logger.error('Tool execution failed:', toolError);

                // Fall back to asking for permission
                const permissionResponse = this.prompts
                  .systemMessages!.toolPermissionError!.template!.replace(
                    '{toolName}',
                    toolSelection.tool
                  )
                  .replace(
                    '{error}',
                    toolError instanceof Error ? toolError.message : 'Unknown error'
                  );

                this.requestProcessor.sendStreamingResponse(
                  res,
                  permissionResponse,
                  this.config.ollama.model
                );
                return;
              }
            } else {
              // Ask for permission for potentially unsafe tools
              logger.info(`Asking permission for potentially unsafe tool: ${toolSelection.tool}`);

              const permissionMessage = this.prompts
                .systemMessages!.toolPermissionRequest!.template!.replace(
                  '{toolName}',
                  toolSelection.tool
                )
                .replace('{args}', JSON.stringify(toolSelection.args));

              this.requestProcessor.sendStreamingResponse(
                res,
                permissionMessage,
                this.config.ollama.model
              );
              return;
            }
          }
        }

        // No tools needed, generate normal response
        const promptStartTime = Date.now();
        const basePrompt = this.requestProcessor.convertMessagesToPrompt(messages);
        const prompt = await this.enhancePromptWithTools(basePrompt);
        logTiming('Prompt preparation', promptStartTime);

        // Debug logging: Final prompt for regular chat
        logger.debug('REGULAR CHAT PROMPT', {
          basePrompt: basePrompt,
          enhancedPrompt: prompt,
          promptLength: prompt.length,
          temperature: temperature,
          maxTokens: max_tokens
        });

        // Always send streaming response to Continue (ignoring stream parameter)
        const ollamaStartTime = Date.now();
        logger.info('Starting streaming response for regular chat');
        await this.ollamaClient.sendToOllamaStreaming(prompt, temperature, max_tokens, res);
        logTiming('Ollama response', ollamaStartTime);

        logTiming('Total chat completion request', startTime);

        logger.info('Successfully processed chat completion');
      } catch (error) {
        logger.error('Error in chat completion:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Completions endpoint for code autocomplete
    this.app.post('/v1/completions', async (req, res) => {
      try {
        logger.info('Received completion request');
        
        // Debug logging: Full completion request body
        logger.debug('COMPLETION REQUEST BODY', {
          fullRequestBody: req.body,
          promptLength: req.body.prompt?.length || 0,
          hasPrompt: !!req.body.prompt,
          stream: req.body.stream,
          maxTokens: req.body.max_tokens,
          temperature: req.body.temperature
        });

        // Store first completion request for debugging
        const compreqPath = this.getTmpPath('compreq.json');
        if (!fs.existsSync(compreqPath)) {
          this.ensureTmpDirectory();
          fs.writeFileSync(compreqPath, JSON.stringify(req.body, null, 2));
          logger.debug('Stored completion request for debugging', { path: compreqPath });
        }

        const { prompt, max_tokens = 50, temperature = 0.2, stream = false } = req.body;

        if (!prompt) {
          return res.status(400).json({ error: 'Prompt is required' });
        }

        // Parse FIM request and create context-aware completion

        const fimRequest = this.requestProcessor.parseFIMRequest(prompt);

        // Extract the immediate code before cursor (last line)
        const lines = fimRequest.prefix.split('\n');
        const codeBeforeCursor = lines[lines.length - 1] || '';

        // Extract only the last file path for language context
        const filePathLines = lines
          .filter(line => line.trim().startsWith('// Path: '))
          .map(line => line.trim());
        const languageContext =
          filePathLines.length > 0 ? filePathLines[filePathLines.length - 1] : '';

        // Create context-aware completion prompt using template
        const completionTemplate = this.prompts.codeCompletion.completion.template!;
        const completionPrompt = completionTemplate
          .replace('{filePath}', languageContext.replace('// Path: ', ''))
          .replace(/\{codeBeforeCursor\}/g, codeBeforeCursor)
          .replace(/\{codeSuffix\}/g, fimRequest.suffix);

        // Debug logging: Code completion prompt construction
        logger.debug('CODE COMPLETION PROMPT', {
          originalPrompt: prompt,
          fimRequest: fimRequest,
          codeBeforeCursor: codeBeforeCursor,
          languageContext: languageContext,
          completionTemplate: completionTemplate,
          finalCompletionPrompt: completionPrompt,
          promptLength: completionPrompt.length
        });

        // Get completion from Ollama using configured settings
        const completionConfig = this.prompts.codeCompletion.completion;
        const rawSuggestion = await this.ollamaClient.sendToOllama(
          completionPrompt,
          completionConfig.temperature,
          completionConfig.maxTokens,
          completionConfig.useFastModel
        );

        logger.info(
          `Raw Ollama response: ${rawSuggestion.substring(0, 200)}${rawSuggestion.length > 200 ? '...' : ''}`
        );

        // Trim the prefix from the response to get just the completion
        let suggestion = rawSuggestion;
        if (rawSuggestion.startsWith(codeBeforeCursor)) {
          suggestion = rawSuggestion.slice(codeBeforeCursor.length);
          logger.info(
            `Trimmed suggestion: ${suggestion.substring(0, 200)}${suggestion.length > 200 ? '...' : ''}`
          );
        } else {
          logger.warn(`Response doesn't start with expected prefix: "${codeBeforeCursor}"`);
          logger.warn(`Response starts with: "${rawSuggestion.substring(0, 50)}"`);
        }

        if (stream) {
          // Handle streaming for autocomplete
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });

          const id = `cmpl-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);

          // Send the suggestion as a single chunk
          const streamChunk = {
            id,
            object: 'text_completion',
            created,
            model: this.config.ollama.model,
            choices: [
              {
                text: suggestion,
                index: 0,
                finish_reason: 'stop',
              },
            ],
          };

          logger.info(
            `Sending to VS Code: ${suggestion.substring(0, 200)}${suggestion.length > 200 ? '...' : ''}`
          );
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
            choices: [
              {
                text: suggestion,
                index: 0,
                finish_reason: 'stop',
              },
            ],
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
      const tools = this.mcpManager.getAvailableTools();
      res.json({ tools });
    });

    // Models endpoint
    this.app.get('/v1/models', (req, res) => {
      res.json({
        object: 'list',
        data: [
          {
            id: this.config.ollama.model,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'local-mcp-hub',
            capabilities: ['tool_use', 'function_calling'],
            supports_tools: true,
          },
        ],
      });
    });

    // Prompts reload endpoint
    this.app.post('/v1/admin/reload-prompts', (req, res) => {
      try {
        this.prompts = this.loadPrompts();
        logger.info('Prompts configuration reloaded successfully');
        res.json({
          success: true,
          message: 'Prompts configuration reloaded successfully',
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('Failed to reload prompts configuration:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to reload prompts configuration',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  public start(): void {
    const port = process.env.PORT ? parseInt(process.env.PORT) : this.config.hub.port;

    // Set up graceful shutdown handlers
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      this.mcpManager.cleanup();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      this.mcpManager.cleanup();
      process.exit(0);
    });

    process.on('uncaughtException', error => {
      logger.error('Uncaught exception:', error);
      this.mcpManager.cleanup();
      process.exit(1);
    });

    this.app.listen(port, async () => {
      logger.info(`Local MCP Hub started on port ${port}`);
      logger.info(`OpenAI-compatible API available at http://localhost:${port}/v1`);
      logger.info(`Health check: http://localhost:${port}/health`);
      logger.info(`Connected to Ollama at: ${this.config.ollama.host}`);

      // Test Ollama connection on startup
      this.ollamaClient.testConnection(this.prompts);

      // Initialize MCP tool schemas and keep processes alive
      await this.mcpManager.initializeMCPSchemas();
    });
  }

  private async enhancePromptWithTools(prompt: string): Promise<string> {
    // Simple heuristic to determine if we should use tools
    const needsCodeAnalysis =
      prompt.toLowerCase().includes('class') ||
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
- Key methods: [methods extracted to separate classes]
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
}

// Start the hub
if (require.main === module) {
  const hub = new LocalMCPHub();
  hub.start();
}

export { LocalMCPHub };
