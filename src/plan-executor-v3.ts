import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { MCPManager, OpenAITool } from './mcp-manager';
import { PlanExecutor } from './plan-executor';
import { RequestProcessor } from './request-processor';
import { PromptManager } from './prompt-manager';

// Intent classification types
export type UserIntent = 'UNDERSTAND' | 'FIND' | 'FIX' | 'BUILD' | 'CONFIGURE';
export type InformationType = 'OVERVIEW' | 'SOURCE' | 'CONFIG' | 'EXPLORE';

// Tool mapping result
export interface ToolMapping {
  tool: string;
  target: string;
  rationale: string;
}

export class PlanExecutorV3 implements PlanExecutor {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private requestProcessor: RequestProcessor;
  private promptManager: PromptManager;
  private mcpManager: MCPManager;

  constructor(
    fullConfig: any,
    ollamaClient: OllamaClient,
    toolSelector: any, // Unused but kept for interface compatibility
    requestProcessor: RequestProcessor,
    mcpManager: MCPManager,
    promptManager: PromptManager,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.requestProcessor = requestProcessor;
    this.promptManager = promptManager;
    this.mcpManager = mcpManager;
    this.logger = logger;
  }

  /**
   * Main entry point - implements PlanExecutor interface
   */
  async handleRequest(
    messages: any[],
    res: any,
    temperature: number,
    maxTokens: number,
    tools: OpenAITool[],
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<void> {
    const userMessage = messages.find(msg => msg.role === 'user');
    const userRequest = userMessage?.content || 'No user request found';
    const projectFileStructure = await projectFileStructureGetter();

    this.logger.info('Plan Executor V3 starting request processing', {
      userRequest: userRequest.substring(0, 100) + '...',
      fileCount: projectFileStructure.split('\n').length
    });

    try {
      // Classify user intent
      const intent = await this.classifyUserIntent(userRequest);
      this.logger.debug('V3: User intent classified', { intent });

      // Classify information type needed
      const infoType = await this.classifyInformationType(userRequest, intent, projectFileStructure);
      this.logger.debug('V3: Information type classified', { infoType });

      // Map to tool and target
      const toolMapping = this.mapToTool(intent, infoType, projectFileStructure);
      this.logger.debug('V3: Tool mapping determined', toolMapping);

      // Execute the tool
      const toolResult = await this.executeTool(toolMapping);
      this.logger.debug('V3: Tool executed', { 
        tool: toolMapping.tool, 
        resultLength: toolResult.length 
      });

      // Generate final response
      await this.generateResponse(userRequest, intent, infoType, toolMapping, toolResult, res);

    } catch (error) {
      this.logger.error('V3: Error in request processing', { error: error instanceof Error ? error.message : 'Unknown error' });
      this.requestProcessor.sendStreamingResponse(res, `I encountered an error while processing your request: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Classify what the user wants to do
   */
  private async classifyUserIntent(userRequest: string): Promise<UserIntent> {
    const promptConfig = this.promptManager.getTemplateByPath('v3.intentClassification');
    if (!promptConfig) {
      this.logger.error('V3: Intent classification prompt not found');
      return 'UNDERSTAND';
    }

    if (!promptConfig.template) {
      this.logger.error('V3: Intent classification template is empty');
      return 'UNDERSTAND';
    }

    const prompt = this.requestProcessor.replaceTemplateVariables(promptConfig.template, {
      userRequest: userRequest
    });

    try {
      const response = await this.ollamaClient.sendToOllama(
        prompt, 
        promptConfig.temperature!, 
        promptConfig.maxTokens!, 
        promptConfig.useFastModel!
      );
      const classification = response.trim().toUpperCase();
      
      const intentMap: { [key: string]: UserIntent } = {
        'A': 'UNDERSTAND',
        'B': 'FIND', 
        'C': 'FIX',
        'D': 'BUILD',
        'E': 'CONFIGURE'
      };

      return intentMap[classification] || 'UNDERSTAND'; // Default fallback
    } catch (error) {
      this.logger.warn('V3: Intent classification failed, using default', { error });
      return 'UNDERSTAND';
    }
  }

  /**
   * Classify what type of information they need
   */
  private async classifyInformationType(userRequest: string, intent: UserIntent, projectFiles: string): Promise<InformationType> {
    const promptConfig = this.promptManager.getTemplateByPath('v3.informationTypeClassification');
    if (!promptConfig) {
      this.logger.error('V3: Information type classification prompt not found');
      return 'OVERVIEW';
    }

    if (!promptConfig.template) {
      this.logger.error('V3: Information type classification template is empty');
      return 'OVERVIEW';
    }

    const prompt = this.requestProcessor.replaceTemplateVariables(promptConfig.template, {
      intent: intent,
      userRequest: userRequest,
      projectFiles: projectFiles.split('\n').slice(0, 20).join(', ')
    });

    try {
      const response = await this.ollamaClient.sendToOllama(
        prompt, 
        promptConfig.temperature!, 
        promptConfig.maxTokens!, 
        promptConfig.useFastModel!
      );
      const classification = response.trim().toUpperCase();
      
      const typeMap: { [key: string]: InformationType } = {
        'A': 'OVERVIEW',
        'B': 'SOURCE',
        'C': 'CONFIG', 
        'D': 'EXPLORE'
      };

      return typeMap[classification] || 'OVERVIEW'; // Default fallback
    } catch (error) {
      this.logger.warn('V3: Information type classification failed, using default', { error });
      return 'OVERVIEW';
    }
  }

  /**
   * Deterministically map intent + info type to tool and target
   */
  private mapToTool(intent: UserIntent, infoType: InformationType, projectFiles: string): ToolMapping {
    const files = projectFiles.split('\n').filter(f => f.trim());
    
    // Find common file types
    const hasReadme = files.find(f => f.toLowerCase().includes('readme'));
    const hasConfig = files.find(f => f.includes('config.json') || f.includes('.env') || f.includes('config'));
    const hasSrcDir = files.find(f => f.startsWith('src/'));
    const hasMainFile = files.find(f => f.includes('main.') || f.includes('app.') || f.includes('index.'));

    // Deterministic mapping based on intent + info type
    const mapping: { [key: string]: ToolMapping } = {
      // UNDERSTAND intents
      'UNDERSTAND_OVERVIEW': {
        tool: 'read_file',
        target: hasReadme || 'README.md',
        rationale: 'README provides project overview for understanding'
      },
      'UNDERSTAND_SOURCE': {
        tool: 'read_file', 
        target: hasMainFile || hasSrcDir || files[0],
        rationale: 'Main implementation files for understanding functionality'
      },
      'UNDERSTAND_CONFIG': {
        tool: 'read_file',
        target: hasConfig || 'config.json',
        rationale: 'Configuration files for understanding setup'
      },
      'UNDERSTAND_EXPLORE': {
        tool: 'list_dir',
        target: '.',
        rationale: 'Directory listing for understanding project structure'
      },

      // FIND intents  
      'FIND_OVERVIEW': {
        tool: 'search_for_pattern',
        target: '.',
        rationale: 'Search documentation for specific information'
      },
      'FIND_SOURCE': {
        tool: 'search_for_pattern', 
        target: 'src',
        rationale: 'Search source code for specific functionality'
      },
      'FIND_CONFIG': {
        tool: 'find_file',
        target: '*config*',
        rationale: 'Find configuration files'
      },
      'FIND_EXPLORE': {
        tool: 'find_file',
        target: '*',
        rationale: 'Find files by pattern'
      },

      // Other intents (simplified for now)
      'FIX_OVERVIEW': {
        tool: 'read_file',
        target: hasReadme || 'README.md', 
        rationale: 'Check documentation for troubleshooting info'
      },
      'BUILD_SOURCE': {
        tool: 'read_file',
        target: hasMainFile || hasSrcDir || files[0],
        rationale: 'Understand existing code before building'
      },
      'CONFIGURE_CONFIG': {
        tool: 'read_file',
        target: hasConfig || 'config.json',
        rationale: 'Read current configuration'
      }
    };

    const key = `${intent}_${infoType}`;
    return mapping[key] || {
      tool: 'read_file',
      target: hasReadme || files[0] || 'README.md',
      rationale: 'Default fallback to documentation'
    };
  }

  /**
   * Execute the selected tool with simple argument generation
   */
  private async executeTool(mapping: ToolMapping): Promise<string> {
    try {
      const args = this.generateToolArguments(mapping.tool, mapping.target);
      this.logger.debug('V3: Generated tool arguments', { tool: mapping.tool, args });
      
      return await this.mcpManager.callMCPTool(mapping.tool, args);
    } catch (error) {
      this.logger.error('V3: Tool execution failed', { error, mapping });
      return `Error executing ${mapping.tool}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Generate tool arguments directly - no complex reasoning needed
   */
  private generateToolArguments(tool: string, target: string): any {
    switch(tool) {
      case 'read_file':
        return { file_path: target };
      
      case 'search_for_pattern':
        return { 
          pattern: target,
          path: '.'
        };
      
      case 'list_dir':
        return { path: target || '.' };
      
      case 'find_file':
        return { file_mask: target };
      
      default:
        this.logger.warn(`V3: Unsupported tool ${tool}, using basic args`);
        return { path: target || '.' };
    }
  }

  /**
   * Generate final response based on tool results
   */
  private async generateResponse(
    userRequest: string, 
    intent: UserIntent, 
    infoType: InformationType, 
    toolMapping: ToolMapping, 
    toolResult: string, 
    res: any
  ): Promise<void> {
    const response = `Based on your request: "${userRequest}"

I classified this as a ${intent} intent requiring ${infoType} information.

I used ${toolMapping.tool} to examine ${toolMapping.target} and found:

${toolResult.substring(0, 2000)}${toolResult.length > 2000 ? '\n\n[Response truncated for brevity]' : ''}

Does this help answer your question?`;

    this.requestProcessor.sendStreamingResponse(res, response);
  }

}