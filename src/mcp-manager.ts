import { spawn, ChildProcess } from 'child_process';
import winston from 'winston';
import path from 'path';

export interface OpenAITool {
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

export interface MCPConfig {
  enabled: string[];
  initializationTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export class MCPManager {
  private logger: winston.Logger;
  private config: MCPConfig;
  private mcpToolSchemas: Map<string, OpenAITool> = new Map();
  private initializationComplete: boolean = false;
  private mcpProcesses: Map<string, ChildProcess> = new Map();
  private mcpProcessReady: Map<string, boolean> = new Map();
  private mcpInitializationStatus: Map<string, 'pending' | 'success' | 'failed'> = new Map();
  private argumentHints: Record<string, Record<string, string>> = {};

  constructor(config: MCPConfig, logger: winston.Logger, argumentHints?: Record<string, Record<string, string>>) {
    this.config = config;
    this.logger = logger;
    this.argumentHints = argumentHints || {};
  }

  get isInitialized(): boolean {
    return this.initializationComplete;
  }

  get areAllProcessesReady(): boolean {
    // Check if all enabled MCP servers are ready (successfully initialized MCPs only)
    if (!this.initializationComplete || this.config.enabled.length === 0) {
      return false;
    }
    
    // At least one MCP must be successfully ready
    for (const mcpName of this.config.enabled) {
      if (this.mcpProcessReady.get(mcpName) === true) {
        return true;
      }
    }
    return false;
  }

  get toolCount(): number {
    return this.mcpToolSchemas.size;
  }

  private get initializationTimeoutMs(): number {
    return this.config.initializationTimeoutMs ?? 60000;
  }

  private get toolCallTimeoutMs(): number {
    return this.config.toolCallTimeoutMs ?? 30000;
  }

  private enhanceParameterWithHints(toolName: string, paramName: string, paramSchema: any): any {
    const hint = this.argumentHints[toolName]?.[paramName];
    if (hint && paramSchema.description) {
      return {
        ...paramSchema,
        description: `${paramSchema.description}. HINT: ${hint}`
      };
    }
    return paramSchema;
  }

  updateArgumentHints(newArgumentHints: Record<string, Record<string, string>> = {}): void {
    this.argumentHints = newArgumentHints;
    
    // Re-enhance existing schemas with new hints
    for (const [toolName, schema] of this.mcpToolSchemas.entries()) {
      const originalProperties = schema.function.parameters.properties || {};
      const enhancedProperties: Record<string, any> = {};
      
      for (const [paramName, paramSchema] of Object.entries(originalProperties)) {
        // Remove old hint if it exists (crude but effective)
        const cleanedSchema = { ...paramSchema };
        if (cleanedSchema.description && cleanedSchema.description.includes('. HINT: ')) {
          cleanedSchema.description = cleanedSchema.description.split('. HINT: ')[0];
        }
        
        enhancedProperties[paramName] = this.enhanceParameterWithHints(
          toolName,
          paramName,
          cleanedSchema
        );
      }

      // Update the cached schema
      schema.function.parameters.properties = enhancedProperties;
    }
    
    this.logger.debug('Updated argument hints for existing schemas');
  }

  getAvailableTools(): string[] {
    return Array.from(this.mcpToolSchemas.keys());
  }

  getOpenAITools(): OpenAITool[] {
    this.logger.debug(
      `DEBUG: Getting OpenAI tools, initializationComplete=${this.initializationComplete}, schemas.size=${this.mcpToolSchemas.size}`
    );

    if (this.initializationComplete && this.mcpToolSchemas.size > 0) {
      const tools = Array.from(this.mcpToolSchemas.values());
      this.logger.debug(`DEBUG: Returning ${tools.length} tools`);
      this.logger.debug(`DEBUG: Tool names: ${tools.map(t => t.function.name).join(', ')}`);
      return tools;
    }

    this.logger.warn('MCP initialization not complete yet, returning empty tools list');
    return [];
  }

  async initializeMCPSchemas(): Promise<void> {
    this.logger.info('Initializing MCP tool schemas in parallel...');

    // Initialize status tracking for all enabled MCPs
    for (const mcpName of this.config.enabled) {
      this.mcpInitializationStatus.set(mcpName, 'pending');
      this.mcpProcessReady.set(mcpName, false);
    }

    if (this.config.enabled.length === 0) {
      this.logger.warn('No MCP servers enabled in configuration');
      this.initializationComplete = true;
      return;
    }

    // Start all MCP initializations in parallel
    const initializationPromises = this.config.enabled.map(async (mcpName) => {
      try {
        this.logger.info(`Starting initialization of ${mcpName}...`);
        const schemas = await this.getMCPToolSchemas(mcpName);
        
        // Add schemas to the global map
        schemas.forEach(schema => {
          this.mcpToolSchemas.set(schema.function.name, schema);
        });
        
        this.mcpInitializationStatus.set(mcpName, 'success');
        this.logger.info(`✓ Successfully loaded ${schemas.length} tool schemas from ${mcpName}`);
        
        return { mcpName, success: true, schemas: schemas.length };
      } catch (error) {
        this.mcpInitializationStatus.set(mcpName, 'failed');
        this.mcpProcessReady.set(mcpName, false);
        this.logger.error(`✗ Failed to load schemas from ${mcpName}:`, error);
        
        return { mcpName, success: false, error: error };
      }
    });

    // Wait for all initialization attempts to complete
    const results = await Promise.allSettled(initializationPromises);
    
    // Log final results
    let successCount = 0;
    let failureCount = 0;
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.success) {
          successCount++;
        } else {
          failureCount++;
        }
      } else {
        failureCount++;
        this.logger.error('Unexpected initialization error:', result.reason);
      }
    }

    this.initializationComplete = true;
    this.logger.info(`MCP initialization complete: ${successCount} successful, ${failureCount} failed`);
    this.logger.info(`Total MCP tools loaded: ${this.mcpToolSchemas.size}`);
    
    // Log the status of each MCP
    for (const mcpName of this.config.enabled) {
      const status = this.mcpInitializationStatus.get(mcpName);
      const ready = this.mcpProcessReady.get(mcpName);
      this.logger.info(`  ${mcpName}: ${status} (ready: ${ready})`);
    }
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
          '--context',
          'ide-assistant',
          '--project',
          path.join(__dirname, '..'),
          '--transport',
          'stdio',
          '--tool-timeout',
          Math.floor(this.toolCallTimeoutMs / 1000).toString(),
          '--log-level',
          'WARNING',
        ];
      } else {
        reject(new Error(`Unknown MCP server: ${mcpName}`));
        return;
      }

      const mcpProcess = spawn(mcpCommand, mcpArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.join(__dirname, '..'),
      });

      // Store process in pool immediately
      this.mcpProcesses.set(mcpName, mcpProcess);
      this.mcpProcessReady.set(mcpName, false);

      let responseBuffer = '';
      let stderrBuffer = '';
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

              // Debug logging: MCP JSON-RPC response
              this.logger.debug('MCP JSON-RPC RESPONSE', {
                mcpName: mcpName,
                messageId: response.id,
                method: response.method || 'response',
                hasResult: !!response.result,
                hasError: !!response.error,
                rawMessage: line.length > 1000 ? line.substring(0, 1000) + '...' : line
              });

              if (response.id === 1 && !initialized) {
                initialized = true;
                this.logger.debug(`${mcpName} MCP server initialized`);

                // Send initialized notification to complete handshake
                const initializedNotification = JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/initialized',
                  params: {},
                });

                // Debug logging: MCP initialized notification
                this.logger.debug('MCP JSON-RPC REQUEST (INITIALIZED)', {
                  mcpName: mcpName,
                  message: initializedNotification
                });

                mcpProcess.stdin?.write(initializedNotification + '\n');
                this.logger.debug(`${mcpName} sent initialized notification`);

                // Follow proper MCP protocol: send tools/list after initialization
                if (mcpName !== 'serena') {
                  const toolsRequest = JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list',
                    params: {},
                  });

                  // Debug logging: MCP tools/list request
                  this.logger.debug('MCP JSON-RPC REQUEST (TOOLS/LIST)', {
                    mcpName: mcpName,
                    message: toolsRequest
                  });

                  mcpProcess.stdin?.write(toolsRequest + '\n');
                  this.logger.debug(`${mcpName} sent tools/list request`);
                }
              } else if (response.id === 2 && response.result) {
                // Tools list response - mark process as ready and resolve with schemas
                const tools = response.result.tools || [];
                for (const tool of tools) {
                  const inputSchema = tool.inputSchema || {
                    type: 'object',
                    properties: {},
                    required: [],
                  };

                  // Enhance parameter descriptions with hints
                  const enhancedProperties: Record<string, any> = {};
                  if (inputSchema.properties) {
                    for (const [paramName, paramSchema] of Object.entries(inputSchema.properties)) {
                      enhancedProperties[paramName] = this.enhanceParameterWithHints(
                        tool.name,
                        paramName,
                        paramSchema
                      );
                    }
                  }

                  schemas.push({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: {
                        ...inputSchema,
                        properties: enhancedProperties,
                      },
                    },
                  });
                }

                // Mark process as ready for tool calls
                this.mcpProcessReady.set(mcpName, true);
                this.logger.info(`${mcpName} process initialized and ready for tool calls`);
                resolve(schemas);
                return;
              }
            } catch (e) {
              // Ignore JSON parse errors
            }
          }
        }
      };

      mcpProcess.stdout?.on('data', data => {
        handleResponse(data.toString());
      });

      mcpProcess.stderr?.on('data', data => {
        const stderr = data.toString();
        stderrBuffer += stderr;
        
        // Log each line of stderr
        const stderrLines = stderrBuffer.split('\n');
        stderrBuffer = stderrLines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of stderrLines) {
          if (line.trim()) {
            this.logger.debug(`${mcpName} stderr:`, line.trim());
          }
        }

        // For Serena, wait for language server to be ready before sending tools/list
        if (
          mcpName === 'serena' &&
          stderr.includes('Language server initialization completed') &&
          initialized
        ) {
          this.logger.info(`${mcpName} language server ready, sending tools/list`);
          const toolsRequest = JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          });

          // Debug logging: MCP tools/list request for Serena
          this.logger.debug('MCP JSON-RPC REQUEST (TOOLS/LIST - SERENA)', {
            mcpName: mcpName,
            message: toolsRequest
          });

          mcpProcess.stdin?.write(toolsRequest + '\n');
        }
      });

      mcpProcess.on('close', code => {
        this.logger.warn(`${mcpName} process closed with code ${code}`);
        this.mcpProcesses.delete(mcpName);
        this.mcpProcessReady.delete(mcpName);
        if (schemas.length === 0) {
          reject(new Error(`Failed to get schemas from ${mcpName}`));
        }
      });

      mcpProcess.on('error', error => {
        this.logger.error(`${mcpName} process error:`, error);
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
          clientInfo: { name: 'local-mcp-hub', version: '1.0.0' },
        },
      });

      // Debug logging: MCP initialization request
      this.logger.debug('MCP JSON-RPC REQUEST (INIT)', {
        mcpName: mcpName,
        message: initRequest
      });

      mcpProcess.stdin?.write(initRequest + '\n');

      // Timeout
      setTimeout(() => {
        if (!this.mcpProcessReady.get(mcpName)) {
          this.logger.error(`${mcpName} initialization timeout`);
          mcpProcess.kill();
          this.mcpProcesses.delete(mcpName);
          this.mcpProcessReady.delete(mcpName);
          reject(new Error(`Timeout getting schemas from ${mcpName}`));
        }
      }, this.initializationTimeoutMs);
    });
  }

  async callMCPTool(toolName: string, args: any = {}): Promise<string> {
    const startTime = Date.now();

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

              // Debug logging: MCP tool call response
              this.logger.debug('MCP JSON-RPC RESPONSE (TOOLS/CALL)', {
                mcpName: mcpName,
                toolName: toolName,
                responseId: response.id,
                hasResult: !!response.result,
                hasError: !!response.error,
                resultSize: response.result ? JSON.stringify(response.result).length : 0,
                rawMessage: line.length > 500 ? line.substring(0, 500) + '...' : line
              });

              // Look for our tool call response
              if (response.id === toolCallId) {
                const duration = Date.now() - startTime;
                this.logger.info(`Timing: MCP tool call: ${toolName} completed`, {
                  duration: `${duration}ms`,
                });

                if (response.result) {
                  // Extract the actual result data from MCP response structure
                  let resultData = 'Tool executed successfully';

                  if (
                    response.result.structuredContent &&
                    response.result.structuredContent.result
                  ) {
                    resultData = response.result.structuredContent.result;
                  } else if (response.result.content && response.result.content.length > 0) {
                    resultData =
                      response.result.content[0].text || JSON.stringify(response.result.content);
                  } else {
                    resultData = JSON.stringify(response.result);
                  }

                  this.logger.debug(`MCP ${mcpName}: ${toolName} succeeded`, {
                    resultLength: resultData.length,
                  });
                  this.logger.debug(`TOOL RESULT DEBUG: ${toolName}`, {
                    fullResult: resultData,
                    resultPreview:
                      resultData.substring(0, 200) + (resultData.length > 200 ? '...' : ''),
                  });
                  cleanup();
                  resolve(resultData);
                } else if (response.error) {
                  this.logger.error(`MCP ${mcpName}: ${toolName} failed`, response.error);
                  cleanup();
                  reject(new Error(`MCP tool error: ${response.error.message}`));
                } else {
                  this.logger.debug(`MCP ${mcpName}: ${toolName} succeeded`);
                  cleanup();
                  resolve('Tool executed successfully');
                }
                return;
              }
            } catch (e) {
              this.logger.warn('Failed to parse MCP response:', line);
            }
          }
        }
      };

      let cleanup = () => {
        process.stdout?.off('data', handleResponse);
        process.stderr?.off('data', errorHandler);
      };

      const errorHandler = (data: Buffer) => {
        this.logger.debug(`${mcpName} stderr:`, data.toString());
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
          arguments: args,
        },
      });

      // Debug logging: MCP tool call request
      this.logger.debug('MCP JSON-RPC REQUEST (TOOLS/CALL)', {
        mcpName: mcpName,
        toolName: toolName,
        message: toolCallRequest,
        args: args
      });

      this.logger.debug(`MCP ${mcpName}: ${toolName}`, { params: args });

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
      }, this.toolCallTimeoutMs);

      // Wrap cleanup and timeout clearing
      const originalCleanup = cleanup;
      cleanup = () => {
        clearTimeout(timeout);
        originalCleanup();
      };
    });
  }

  cleanup(): void {
    this.logger.info('Cleaning up MCP processes...');
    for (const [mcpName, process] of this.mcpProcesses) {
      try {
        this.logger.info(`Terminating ${mcpName} process`);
        process.kill('SIGTERM');
      } catch (error) {
        this.logger.warn(`Failed to terminate ${mcpName} process:`, error);
      }
    }
    this.mcpProcesses.clear();
    this.mcpProcessReady.clear();
  }
}
