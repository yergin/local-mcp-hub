import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { OpenAITool } from './mcp-manager';

export interface ToolGuidanceConfig {
  usageHints?: Record<string, string>;
  fastModelTools?: string[];
  safeTools?: string[];
}

export interface ToolSelectionConfig {
  stage1: {
    template: string;
    temperature: number;
    maxTokens: number;
    useFastModel: boolean;
  };
}

export interface ArgumentGenerationConfig {
  fastModel: {
    template: string;
    temperature: number;
    useFastModel: boolean;
  };
  fullModel: {
    template: string;
    temperature: number;
    useFastModel: boolean;
  };
}

export interface ToolSelectionResult {
  tool: string;
  args: any;
}

export class ToolSelector {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private toolGuidance: ToolGuidanceConfig;
  private toolSelectionConfig: ToolSelectionConfig;
  private argumentGenerationConfig: ArgumentGenerationConfig;

  constructor(
    ollamaClient: OllamaClient,
    toolGuidance: ToolGuidanceConfig,
    toolSelectionConfig: ToolSelectionConfig,
    argumentGenerationConfig: ArgumentGenerationConfig,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.toolGuidance = toolGuidance;
    this.toolSelectionConfig = toolSelectionConfig;
    this.argumentGenerationConfig = argumentGenerationConfig;
    this.logger = logger;
  }

  enhanceToolWithUsageGuidance(schema: OpenAITool): OpenAITool {
    const guidance = this.getToolUsageGuidance(schema.function.name);
    this.logger.debug(
      `DEBUG: Enhancing tool ${schema.function.name}, guidance found: ${guidance ? 'YES' : 'NO'}`
    );

    if (!guidance) return schema;

    const enhanced = {
      ...schema,
      function: {
        ...schema.function,
        description: `${schema.function.description}. ${guidance}`,
      },
    };

    this.logger.debug(
      `DEBUG: Enhanced ${schema.function.name} description: ${enhanced.function.description}`
    );
    return enhanced;
  }

  private getToolUsageGuidance(toolName: string): string | null {
    return this.toolGuidance.usageHints?.[toolName] || null;
  }

  isSafeTool(toolName: string): boolean {
    return this.toolGuidance.safeTools?.includes(toolName) || false;
  }

  private isSimpleArgumentGeneration(toolName: string): boolean {
    return this.toolGuidance.fastModelTools?.includes(toolName) || false;
  }

  async selectToolWithLLM(
    messages: any[],
    tools: OpenAITool[]
  ): Promise<ToolSelectionResult | null> {
    const startTime = Date.now();
    const lastMessage = messages[messages.length - 1];
    const userRequest = lastMessage.content;

    this.logger.debug(`DEBUG: User request: "${userRequest}"`);
    this.logger.debug(`DEBUG: Number of tools: ${tools.length}`);

    // Stage 1: Select the tool using only names and USE WHEN descriptions
    const toolNames = tools
      .map(tool => {
        const guidance = this.getToolUsageGuidance(tool.function.name);
        const shortDesc = tool.function.description.split('.')[0]; // Take first sentence only
        return `- ${tool.function.name}: ${shortDesc}${guidance ? '. ' + guidance : ''}`;
      })
      .join('\n');

    const toolSelectionTemplate = this.toolSelectionConfig.stage1.template;
    const toolSelectionPrompt = toolSelectionTemplate
      .replace('{userRequest}', userRequest)
      .replace('{toolNames}', toolNames);

    this.logger.debug(`DEBUG: Stage 1 prompt length: ${toolSelectionPrompt.length} chars`);
    this.logger.debug(`DEBUG: Full Stage 1 prompt:\n${toolSelectionPrompt}`);

    try {
      // Stage 1: Select the tool using fast model
      const stage1StartTime = Date.now();
      const stage1Config = this.toolSelectionConfig.stage1;
      const toolResponse = await this.ollamaClient.sendToOllama(
        toolSelectionPrompt,
        stage1Config.temperature,
        stage1Config.maxTokens,
        stage1Config.useFastModel
      );
      this.logTiming('Stage 1 tool selection (fast model)', stage1StartTime);
      const cleanToolResponse = toolResponse
        .trim()
        .replace(/```json|```/g, '')
        .trim();

      this.logger.debug(`DEBUG: Stage 1 response: "${cleanToolResponse}"`);
      this.logger.info(`RAW LLM RESPONSE: "${toolResponse}"`);
      this.logger.info(`CLEANED RESPONSE: "${cleanToolResponse}"`);

      let toolSelection;
      try {
        toolSelection = JSON.parse(cleanToolResponse);
      } catch (parseError) {
        this.logger.error(`Failed to parse tool selection JSON: ${parseError}`, {
          response: cleanToolResponse,
        });
        return null;
      }

      if (!toolSelection.tool || toolSelection.tool === null) {
        this.logger.info('No tool selected by LLM');
        return null;
      }

      // Find the selected tool
      const selectedTool = tools.find(t => t.function.name === toolSelection.tool);
      if (!selectedTool) {
        this.logger.warn(`LLM selected non-existent tool: ${toolSelection.tool}`);
        return null;
      }

      this.logger.info(`Stage 1: LLM selected tool: ${toolSelection.tool}`);

      // Stage 2: Generate arguments using smart model selection
      const stage2StartTime = Date.now();
      let argsSelection;

      if (this.isSimpleArgumentGeneration(toolSelection.tool)) {
        this.logger.info('Using fast model for simple argument generation', {
          tool: toolSelection.tool,
        });
        argsSelection = await this.generateArgsWithFastModel(userRequest, selectedTool);
      } else {
        this.logger.info(
          `🧠 Using full model for complex argument generation: ${toolSelection.tool}`
        );
        argsSelection = await this.generateArgsWithFullModel(userRequest, selectedTool);
      }

      const modelType = this.isSimpleArgumentGeneration(toolSelection.tool)
        ? 'fast model'
        : 'full model';
      this.logTiming(`Stage 2 argument generation (${modelType})`, stage2StartTime);
      this.logger.info(`Stage 2: Generated args: ${JSON.stringify(argsSelection.args)}`);

      this.logTiming('Total tool selection', startTime);

      return {
        tool: toolSelection.tool,
        args: argsSelection.args || {},
      };
    } catch (error) {
      this.logger.error('Error in two-stage tool selection:', error);
      return null;
    }
  }

  private async generateArgsWithFastModel(
    userRequest: string,
    toolSchema: OpenAITool
  ): Promise<any> {
    const params = Object.entries(toolSchema.function.parameters.properties || {})
      .map(
        ([name, schema]: [string, any]) =>
          `- ${name} (${schema.type}): ${schema.description || 'No description'}`
      )
      .join('\n');

    // Use configured prompt template for fast model
    const fastArgsTemplate = this.argumentGenerationConfig.fastModel.template;
    const argsPrompt = fastArgsTemplate
      .replace('{toolName}', toolSchema.function.name)
      .replace('{userRequest}', userRequest)
      .replace('{params}', params);

    this.logger.debug(`DEBUG: Fast model Stage 2 prompt length: ${argsPrompt.length} chars`);

    const fastArgsConfig = this.argumentGenerationConfig.fastModel;
    const argsResponse = await this.ollamaClient.sendToOllama(
      argsPrompt,
      fastArgsConfig.temperature,
      undefined,
      fastArgsConfig.useFastModel
    );
    const cleanArgsResponse = argsResponse
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    this.logger.debug(`DEBUG: Fast model Stage 2 response: "${cleanArgsResponse}"`);

    const parsedArgs = JSON.parse(cleanArgsResponse);

    // Strip problematic parameters that the fast model incorrectly adds
    if (parsedArgs.args && parsedArgs.args.max_answer_chars !== undefined) {
      delete parsedArgs.args.max_answer_chars;
      this.logger.debug('Stripped max_answer_chars from fast model response');
    }

    return parsedArgs;
  }

  private async generateArgsWithFullModel(
    userRequest: string,
    toolSchema: OpenAITool
  ): Promise<any> {
    const params = Object.entries(toolSchema.function.parameters.properties || {})
      .map(
        ([name, schema]: [string, any]) =>
          `- ${name} (${schema.type}): ${schema.description || 'No description'}`
      )
      .join('\n');

    // Use configured prompt template for full model
    const fullArgsTemplate = this.argumentGenerationConfig.fullModel.template;
    const argsPrompt = fullArgsTemplate
      .replace('{userRequest}', userRequest)
      .replace('{toolName}', toolSchema.function.name)
      .replace('{toolDescription}', toolSchema.function.description)
      .replace('{params}', params);

    this.logger.debug(`DEBUG: Full model Stage 2 prompt length: ${argsPrompt.length} chars`);

    const fullArgsConfig = this.argumentGenerationConfig.fullModel;
    const argsResponse = await this.ollamaClient.sendToOllama(
      argsPrompt,
      fullArgsConfig.temperature,
      undefined,
      fullArgsConfig.useFastModel
    );
    const cleanArgsResponse = argsResponse
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    this.logger.debug(`DEBUG: Full model Stage 2 response: "${cleanArgsResponse}"`);

    const parsedArgs = JSON.parse(cleanArgsResponse);

    // Filter out null values from full model response
    if (parsedArgs.args && typeof parsedArgs.args === 'object') {
      Object.keys(parsedArgs.args).forEach(key => {
        if (parsedArgs.args[key] === null) {
          delete parsedArgs.args[key];
          this.logger.debug(`Filtered out null parameter: ${key}`);
        }
      });
    }

    return parsedArgs;
  }

  private logTiming(operation: string, startTime: number, metadata?: object): void {
    const duration = Date.now() - startTime;
    this.logger.info(`Timing: ${operation} completed`, { duration: `${duration}ms`, ...metadata });
  }
}
