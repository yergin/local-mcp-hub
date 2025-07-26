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
import { RequestProcessor } from './request-processor';
import { PlanExecutor } from './plan-executor';
import { PlanExecutorV1 } from './plan-executor-v1';
import { PlanExecutorV2 } from './plan-executor-v2';
import { PlanExecutorV3 } from './plan-executor-v3';
import { PromptManager } from './prompt-manager';

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
  v1?: {
    toolSelection: {
      stage1: PromptConfig;
    };
    argumentGeneration: {
      fastModel: PromptConfig;
      fullModel: PromptConfig;
    };
  };
  v3?: {
    intentClassification: PromptConfig;
    informationTypeClassification: PromptConfig;
  };
  codeCompletion: {
    completion: PromptConfig;
  };
  toolGuidance?: {
    usageHints?: Record<string, string>;
    fastModelTools?: string[];
    safeTools?: string[];
    toolsBlackList?: string[];
    argumentHints?: Record<string, Record<string, string>>;
  };
  responseGeneration?: {
    parallelTasks?: { template?: string; temperature?: number; maxTokens?: number };
  };
  systemMessages?: {
    customSystemPrompt?: { template?: string; enabled?: boolean };
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
    default_temperature?: number;
    default_max_tokens?: number;
    executor?: 'v1' | 'v2' | 'v3'; // Which plan executor to use (defaults to 'v1' if not specified)
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
  private promptManager: PromptManager;
  private ollamaClient: OllamaClient;
  private mcpManager: MCPManager;
  private toolSelector: ToolSelector;
  private requestProcessor: RequestProcessor;
  private planExecutor: PlanExecutorV1;
  private planExecutorV2: PlanExecutorV2;
  private planExecutorV3: PlanExecutorV3;
  private selectedExecutor: PlanExecutor;
  private cachedProjectFileStructure: string | null = null;
  private projectFileStructureTimestamp: number = 0;

  constructor() {
    this.app = express();
    this.config = this.loadConfig();
    this.prompts = this.loadPrompts();
    this.ensureTmpDirectory();

    // Initialize prompt manager
    const promptsPath = path.join(__dirname, '..', 'prompts.json');
    this.promptManager = new PromptManager(promptsPath, logger);

    // Initialize extracted classes
    this.ollamaClient = new OllamaClient(this.config.ollama, logger);
    this.mcpManager = new MCPManager(
      this.config.mcps, 
      logger, 
      this.prompts.toolGuidance?.argumentHints,
      this.prompts.toolGuidance?.usageHints
    );
    this.toolSelector = new ToolSelector(
      this.ollamaClient,
      this.prompts.toolGuidance || {},
      this.prompts.v1?.toolSelection as any,
      this.prompts.v1?.argumentGeneration as any,
      logger
    );
    this.requestProcessor = new RequestProcessor(
      this.ollamaClient,
      this.prompts.systemMessages || {},
      this.toolSelector,
      logger
    );
    
    // Initialize plan executors with full config
    this.planExecutor = new PlanExecutorV1(
      this.config,
      this.ollamaClient,
      this.toolSelector,
      this.requestProcessor,
      this.mcpManager,
      this.promptManager,
      logger
    );
    
    this.planExecutorV2 = new PlanExecutorV2(
      this.config,
      this.ollamaClient,
      this.requestProcessor,
      this.promptManager,
      logger
    );

    this.planExecutorV3 = new PlanExecutorV3(
      this.config,
      this.ollamaClient,
      this.toolSelector,
      this.requestProcessor,
      this.mcpManager,
      this.promptManager,
      logger
    );

    // Select which executor to use based on configuration
    this.selectedExecutor = this.selectExecutor();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private selectExecutor(): PlanExecutor {
    // Select executor based on configuration (guaranteed to be valid after config loading)
    switch (this.config.hub.executor) {
      case 'v1':
        logger.info('Using Plan Executor V1');
        return this.planExecutor;
      case 'v2':
        logger.info('Using Plan Executor V2');
        return this.planExecutorV2;
      case 'v3':
        logger.info('Using Plan Executor V3');
        return this.planExecutorV3;
      default:
        // This should never happen due to validation in loadConfig()
        throw new Error(`Unexpected executor type: ${this.config.hub.executor}`);
    }
  }

  private loadConfig(): Config {
    try {
      const configPath = path.join(__dirname, '..', 'config.json');
      const configData = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData) as Config;

      // Set default executor if not specified
      if (!config.hub.executor) {
        config.hub.executor = 'v1';
        logger.warn('No executor specified in config, defaulting to v1');
      }

      // Validate executor value
      if (config.hub.executor !== 'v1' && config.hub.executor !== 'v2' && config.hub.executor !== 'v3') {
        logger.error(`Invalid executor "${config.hub.executor}" in config. Must be 'v1', 'v2', or 'v3'. Defaulting to 'v1'.`);
        config.hub.executor = 'v1';
      }

      // Update logger level based on config and environment variable
      const logLevel = config.hub.log_level || process.env.LOG_LEVEL || 'info';
      logger.level = logLevel;

      logger.info('Configuration loaded', {
        ollamaHost: config.ollama.host,
        port: config.hub.port,
        executor: config.hub.executor,
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

  /**
   * Generic method to get temperature and maxTokens from prompt config with fallbacks
   * @param promptConfig The specific prompt configuration object
   * @param requestTemperature Temperature from HTTP request (fallback)
   * @param requestMaxTokens MaxTokens from HTTP request (fallback)
   * @returns Object with temperature and maxTokens values
   */
  private getPromptParameters(
    promptConfig: { temperature?: number; maxTokens?: number } | undefined,
    requestTemperature: number,
    requestMaxTokens: number
  ): { temperature: number; maxTokens: number } {
    const temperature = promptConfig?.temperature ?? 
                       this.config.hub.default_temperature ?? 
                       requestTemperature;
                       
    const maxTokens = promptConfig?.maxTokens ?? 
                     this.config.hub.default_max_tokens ?? 
                     requestMaxTokens;
    
    return { temperature, maxTokens };
  }

  private async getProjectFileStructure(forceRefresh: boolean = false): Promise<string> {
    // Use cached version if available and not forcing refresh
    if (!forceRefresh && this.cachedProjectFileStructure && Date.now() - this.projectFileStructureTimestamp < 30000) {
      logger.debug('Using cached project file structure');
      return this.cachedProjectFileStructure;
    }

    try {
      if (!this.mcpManager.areAllProcessesReady) {
        return 'Project file structure unavailable (MCP tools initializing)';
      }

      logger.debug(forceRefresh ? 'Refreshing project file structure' : 'Building initial project file structure');

      // Get recursive directory listing and prune to 1 level deep
      const result = await this.mcpManager.callMCPTool('list_dir', { 
        relative_path: '.', 
        recursive: true 
      });
      const data = JSON.parse(result);

      const allItems: string[] = [];

      // Add files up to 1 level deep
      if (data.files) {
        for (const file of data.files) {
          const pathParts = file.split('/');
          if (pathParts.length <= 2) {
            allItems.push(file);
          }
        }
      }

      // Add directories up to 1 level deep (with trailing slash)
      if (data.dirs) {
        for (const dir of data.dirs) {
          const pathParts = dir.split('/');
          if (pathParts.length <= 2) {
            allItems.push(dir + '/');
          }
        }
      }

      // Sort alphabetically
      allItems.sort();

      const projectFileStructure = allItems.join('\n');
      
      // Cache the result
      this.cachedProjectFileStructure = projectFileStructure;
      this.projectFileStructureTimestamp = Date.now();
      
      return projectFileStructure;
    } catch (error) {
      logger.warn('Failed to gather project file structure:', error);
      return 'Project file structure unavailable';
    }
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
          stream = false,
          tools,
          tool_choice,
        } = req.body;
        
        // Always use our own reasonable defaults, ignore Continue's max_tokens
        const max_tokens = 4000;

        if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: 'Invalid messages format' });
        }

        // Check if this is a tool call response (messages contain tool results)
        const hasToolResults = messages.some(msg => msg.role === 'tool');

        if (hasToolResults) {
          // Delegate to selected executor
          const mcpTools = this.mcpManager.getOpenAITools();
          
          await this.selectedExecutor.handleRequest(
            messages,
            res,
            temperature,
            max_tokens,
            mcpTools,
            (forceRefresh?: boolean) => this.getProjectFileStructure(forceRefresh),
            this.config.hub.default_temperature,
            this.config.hub.default_max_tokens
          );
          return;
        }

        // Check if all MCP processes are ready yet
        if (!this.mcpManager.areAllProcessesReady) {
          logger.warn('MCP tools not yet ready, sending initialization message');
          const initMessage = this.prompts.systemMessages!.mcpInitializing!.template!.replace(
            '{port}',
            this.config.hub.port.toString()
          );

          this.requestProcessor.sendStreamingResponse(res, initMessage, this.config.ollama.model);
          return;
        }

        // Always inject our MCP tools
        const toolsStartTime = Date.now();
        const mcpTools = this.mcpManager.getOpenAITools();
        logTiming('MCP tools retrieval', toolsStartTime, { toolCount: mcpTools.length });
        logger.debug('Available MCP tools', {
          tools: mcpTools.map((t: OpenAITool) => t.function.name),
        });

        // Delegate to selected executor for tool selection and execution
        await this.selectedExecutor.handleRequest(
          messages,
          res,
          temperature,
          max_tokens,
          mcpTools,
          (forceRefresh?: boolean) => this.getProjectFileStructure(forceRefresh),
          this.config.hub.default_temperature,
          this.config.hub.default_max_tokens
        );

        logTiming('Total chat completion request', startTime);
        return;

        // No tools needed, generate normal response
        const promptStartTime = Date.now();
        const prompt = this.requestProcessor.convertMessagesToPrompt(messages);
        logTiming('Prompt preparation', promptStartTime);

        // Debug logging: Final prompt for regular chat
        logger.debug('REGULAR CHAT PROMPT', {
          prompt: prompt,
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
        const templateVariables: Record<string, string> = {
          filePath: languageContext.replace('// Path: ', ''),
          codeBeforeCursor: codeBeforeCursor,
          codeSuffix: fimRequest.suffix
        };
        const completionPrompt = this.requestProcessor.replaceTemplateVariables(completionTemplate, templateVariables);

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

    // Get schemas for all MCP tools in OpenAI format
    this.app.get('/v1/tools/schemas', (req, res) => {
      try {
        if (!this.mcpManager.isInitialized) {
          return res.status(503).json({
            error: 'Service unavailable',
            message: 'MCP tools are still initializing',
            isInitialized: false,
            retryAfter: 5 // seconds
          });
        }

        // Return the OpenAI-formatted tool schemas directly
        const tools = this.mcpManager.getOpenAITools();
        
        res.json({
          tools,
          count: tools.length,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error getting tool schemas:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Run a specific MCP tool using OpenAI function calling format
    this.app.post('/v1/tools/run', async (req, res) => {
      try {
        // Support both OpenAI format and simplified format for backwards compatibility
        let toolName: string;
        let toolArgs: any;

        if (req.body.type === 'function' && req.body.function) {
          // OpenAI format
          toolName = req.body.function.name;
          // Parse arguments if they're a JSON string (OpenAI format)
          if (typeof req.body.function.arguments === 'string') {
            try {
              toolArgs = JSON.parse(req.body.function.arguments);
            } catch (e) {
              return res.status(400).json({
                error: 'Bad request',
                message: 'Invalid JSON in function.arguments'
              });
            }
          } else {
            toolArgs = req.body.function.arguments || {};
          }
        } else if (req.body.tool_name) {
          // Simplified format (backwards compatibility)
          toolName = req.body.tool_name;
          toolArgs = req.body.arguments || {};
        } else {
          return res.status(400).json({
            error: 'Bad request',
            message: 'Invalid request format. Use OpenAI function calling format or provide tool_name'
          });
        }

        if (!toolName) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'Tool name is required'
          });
        }

        if (!this.mcpManager.areAllProcessesReady) {
          return res.status(503).json({
            error: 'Service unavailable',
            message: 'MCP tools are still initializing',
            isInitialized: false,
            retryAfter: 5
          });
        }

        // Check if tool exists
        const availableTools = this.mcpManager.getAvailableTools();
        if (!availableTools.includes(toolName)) {
          return res.status(404).json({
            error: 'Tool not found',
            message: `Tool "${toolName}" does not exist`,
            availableTools
          });
        }

        logger.info(`Running MCP tool: ${toolName}`, { args: toolArgs });

        // Execute the tool
        const startTime = Date.now();
        const result = await this.mcpManager.callMCPTool(toolName, toolArgs);
        const duration = Date.now() - startTime;

        res.json({
          success: true,
          tool_name: toolName,
          result,
          duration: `${duration}ms`,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error running MCP tool:', error);
        res.status(500).json({
          error: 'Tool execution failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
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
        // Reload prompts in the centralized manager
        this.promptManager.reloadPrompts();
        
        // Also reload the old prompts for backward compatibility
        this.prompts = this.loadPrompts();
        
        // Update all components with new prompts configuration
        this.toolSelector.updateConfig(
          this.prompts.toolGuidance || {},
          this.prompts.v1?.toolSelection as any,
          this.prompts.v1?.argumentGeneration as any
        );
        
        this.requestProcessor.updateConfig(
          this.prompts.systemMessages || {}
        );

        // Update MCP Manager with new argument and usage hints
        this.mcpManager.updateHints(
          this.prompts.toolGuidance?.argumentHints,
          this.prompts.toolGuidance?.usageHints
        );
        
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
}

// Start the hub
if (require.main === module) {
  const hub = new LocalMCPHub();
  hub.start();
}

export { LocalMCPHub };
