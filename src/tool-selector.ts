import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { OpenAITool } from './mcp-manager';

export interface ToolGuidanceConfig {
  usageHints?: Record<string, string>;
  fastModelTools?: string[];
  readOnlyTools?: string[];
  toolsBlackList?: string[];
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

  /**
   * Generic method to replace variables in a template string
   * @param template The template string containing variables like {variableName}
   * @param variables Object containing variable names and their replacement values
   * @returns The template with all variables replaced
   */
  private replaceTemplateVariables(template: string, variables: Record<string, string>): string {
    let result = template;
    
    // Replace each variable in the template
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      // Use global replace to handle multiple occurrences
      result = result.split(placeholder).join(value || '');
    }
    
    return result;
  }

  updateConfig(
    toolGuidance: ToolGuidanceConfig,
    toolSelectionConfig: ToolSelectionConfig,
    argumentGenerationConfig: ArgumentGenerationConfig
  ): void {
    this.toolGuidance = toolGuidance;
    this.toolSelectionConfig = toolSelectionConfig;
    this.argumentGenerationConfig = argumentGenerationConfig;
    this.logger.debug('ToolSelector configuration updated');
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
    return this.toolGuidance.readOnlyTools?.includes(toolName) || false;
  }

  isSimpleArgumentGeneration(toolName: string): boolean {
    return this.toolGuidance.fastModelTools?.includes(toolName) || false;
  }

  formatToolsWithUsageHints(tools: OpenAITool[]): string {
    // Filter out blacklisted tools
    const blacklist = this.toolGuidance.toolsBlackList || [];
    const filteredTools = tools.filter(tool => !blacklist.includes(tool.function.name));
    
    return filteredTools
      .map(tool => {
        const normalizedName = tool.function.name.replace(/-/g, '_');
        const guidance = this.getToolUsageGuidance(tool.function.name);
        const shortDesc = tool.function.description.split('.')[0]; // Take first sentence only
        return `- ${normalizedName}: ${shortDesc}${guidance ? '. ' + guidance : ''}`;
      })
      .join('\n');
  }

  async selectToolWithLLM(
    messages: any[],
    tools: OpenAITool[],
    directoryContext?: string,
    projectFileStructure?: string
  ): Promise<ToolSelectionResult | null> {
    const startTime = Date.now();
    const lastMessage = messages[messages.length - 1];
    const userRequest = lastMessage.content;

    this.logger.debug(`DEBUG: User request: "${userRequest}"`);
    this.logger.debug(`DEBUG: Number of tools: ${tools.length}`);

    // Stage 1: Select only from read-only tools for information gathering, excluding blacklisted tools
    const readOnlyToolNames = this.toolGuidance.readOnlyTools || [];
    const blacklist = this.toolGuidance.toolsBlackList || [];
    const readOnlyTools = tools.filter(tool => 
      readOnlyToolNames.includes(tool.function.name) && !blacklist.includes(tool.function.name)
    );
    
    this.logger.debug(`DEBUG: Filtered to ${readOnlyTools.length} read-only tools from ${tools.length} total tools`);
    
    // Create mapping from normalized names (underscores) to actual tool objects
    const normalizedToolMap = new Map<string, OpenAITool>();
    readOnlyTools.forEach(tool => {
      const normalizedName = tool.function.name.replace(/-/g, '_');
      normalizedToolMap.set(normalizedName, tool);
    });
    
    const toolNames = this.formatToolsWithUsageHints(readOnlyTools);

    const toolSelectionTemplate = this.toolSelectionConfig.stage1.template;
    const templateVariables: Record<string, string> = {
      userRequest: userRequest,
      projectFileStructure: projectFileStructure || 'Project file structure not available',
      toolNames: toolNames
    };
    const toolSelectionPrompt = this.replaceTemplateVariables(toolSelectionTemplate, templateVariables);

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

      // Find the selected tool using normalized name mapping
      const selectedTool = normalizedToolMap.get(toolSelection.tool);
      if (!selectedTool) {
        this.logger.warn(`LLM selected tool not in read-only list: ${toolSelection.tool}`);
        return null;
      }

      this.logger.info(`Stage 1: LLM selected tool: ${toolSelection.tool} -> ${selectedTool.function.name}`);

      // Stage 2: Generate arguments using smart model selection
      const stage2StartTime = Date.now();
      let argsSelection;

      // Use the prompt from toolSelection for argument generation
      const toolPrompt = toolSelection.prompt || userRequest;

      if (this.isSimpleArgumentGeneration(toolSelection.tool)) {
        this.logger.info('Using fast model for simple argument generation', {
          tool: toolSelection.tool,
          prompt: toolPrompt
        });
        argsSelection = await this.generateArgsWithFastModel(toolPrompt, selectedTool, projectFileStructure);
      } else {
        this.logger.info(
          `🧠 Using full model for complex argument generation: ${toolSelection.tool}`
        );
        argsSelection = await this.generateArgsWithFullModel(toolPrompt, selectedTool, projectFileStructure);
      }

      const modelType = this.isSimpleArgumentGeneration(toolSelection.tool)
        ? 'fast model'
        : 'full model';
      this.logTiming(`Stage 2 argument generation (${modelType})`, stage2StartTime);
      this.logger.info(`Stage 2: Generated args: ${JSON.stringify(argsSelection.args)}`);

      this.logTiming('Total tool selection', startTime);

      return {
        tool: selectedTool.function.name,
        args: argsSelection.args || {},
      };
    } catch (error) {
      this.logger.error('Error in two-stage tool selection:', error);
      return null;
    }
  }

  async generateArgsWithFastModel(
    userRequest: string,
    toolSchema: OpenAITool,
    projectFileStructure?: string
  ): Promise<any> {
    const requiredParams = toolSchema.function.parameters.required || [];
    const params = Object.entries(toolSchema.function.parameters.properties || {})
      .map(
        ([name, schema]: [string, any]) => {
          const isRequired = requiredParams.includes(name);
          const typeInfo = isRequired ? schema.type : `${schema.type}, optional`;
          return `- ${name} (${typeInfo}): ${schema.description || 'No description'}`;
        }
      )
      .join('\n');

    // Use configured prompt template for fast model
    const fastArgsTemplate = this.argumentGenerationConfig.fastModel.template;
    const templateVariables: Record<string, string> = {
      projectFileStructure: projectFileStructure || 'Project structure not available',
      toolName: toolSchema.function.name,
      toolDescription: toolSchema.function.description,
      userRequest: userRequest,
      params: params
    };
    const argsPrompt = this.replaceTemplateVariables(fastArgsTemplate, templateVariables);

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

  async generateArgsWithFullModel(
    userRequest: string,
    toolSchema: OpenAITool,
    projectFileStructure?: string
  ): Promise<any> {
    const requiredParams = toolSchema.function.parameters.required || [];
    const params = Object.entries(toolSchema.function.parameters.properties || {})
      .map(
        ([name, schema]: [string, any]) => {
          const isRequired = requiredParams.includes(name);
          const typeInfo = isRequired ? schema.type : `${schema.type}, optional`;
          return `- ${name} (${typeInfo}): ${schema.description || 'No description'}`;
        }
      )
      .join('\n');

    // Use configured prompt template for full model
    const fullArgsTemplate = this.argumentGenerationConfig.fullModel.template;
    const templateVariables: Record<string, string> = {
      projectFileStructure: projectFileStructure || 'Project structure not available',
      userRequest: userRequest,
      toolName: toolSchema.function.name,
      toolDescription: toolSchema.function.description,
      params: params
    };
    const argsPrompt = this.replaceTemplateVariables(fullArgsTemplate, templateVariables);

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
