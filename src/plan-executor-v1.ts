import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { ToolSelector } from './tool-selector';
import { MCPManager, OpenAITool } from './mcp-manager';
import { PromptManager } from './prompt-manager';
import { PlanExecutor } from './plan-executor';
import { 
  RequestProcessor, 
  AssistantToolResult
} from './request-processor';

// Stage1 tool selection interfaces
export interface Stage1ToolSelection {
  tool: string;
  prompt: string;
  args?: any;
}

export interface Stage1Config {
  template: string;
  temperature: number;
  maxTokens: number;
  useFastModel: boolean;
}

// Step-related interfaces (moved from RequestProcessor)
export interface CurrentStepIterationResponse {
  current_step: {
    notes_to_future_self: string;
    tool: string;
    prompt: string;
  };
  later_steps?: string[];
}

export interface CurrentStepCompleteResponse {
  current_step: {
    completed: true;
    success: boolean;
    notes_to_future_self: string;
  };
  next_step?: {
    objective: string;
    tool: string;
    prompt: string;
  };
  later_steps?: string[];
}

export interface NextStepResponse {
  objective: string;
  tool: string;
  prompt: string;
}

export interface ToolCallRecord {
  prompt: string;
  tool: string;
  args: string; // JSON stringified
}

export interface CompletedStepRequest {
  objective: string;
  success: boolean;
  conclusion: string;
  toolCalls: ToolCallRecord[];
}

export interface CurrentStepRequest {
  objective: string;
  completed: boolean;
  notes: string; // notes_to_future_self
  assistant: AssistantToolResult;
}

// Plan-specific interfaces
export interface PlanStep {
  purpose: string;
  tool: string;
  prompt: string;
}

export interface PlanResponse {
  main_objective: string;
  conclusion_from_junior_assistant_data?: string;
  junior_assistant_data_was_helpful?: boolean;
  next_step?: NextStepResponse;
  later_steps: string[];
}

export interface PlanExecutionState {
  objective: string;
  completedSteps: CompletedStepRequest[];
  currentStep?: NextStepResponse;
  currentStepNotes?: string; // notes_to_future_self from previous iterations
  currentStepAssistant?: AssistantToolResult; // current tool result for current step
  currentStepToolCalls: ToolCallRecord[]; // track all tool calls for current step
  laterSteps: string[];
  stepResults: string[];
}

export interface ResponseGenerationConfig {
  planDecision?: { template?: string };
  planIteration?: { template?: string };
  finalIteration?: { template?: string };
  stepLimitIteration?: { template?: string };
  planDecisionAssistant?: { template?: string };
  previousTool?: { template?: string };
  previousStep?: { template?: string };
}

export interface PlanExecutorConfig {
  stepLimit: number;
  totalIterationLimit: number;
  stepIterationLimit: number;
}

export class PlanExecutorV1 implements PlanExecutor {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private toolSelector: ToolSelector;
  private requestProcessor: RequestProcessor;
  private mcpManager: MCPManager;
  private promptManager: PromptManager;
  private config: PlanExecutorConfig;
  private fullHubConfig: any; // Store full hub config for access to prompts

  constructor(
    fullConfig: any, // Full hub configuration
    ollamaClient: OllamaClient,
    toolSelector: ToolSelector,
    requestProcessor: RequestProcessor,
    mcpManager: MCPManager,
    promptManager: PromptManager,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.toolSelector = toolSelector;
    this.requestProcessor = requestProcessor;
    this.mcpManager = mcpManager;
    this.promptManager = promptManager;
    this.logger = logger;
    this.fullHubConfig = fullConfig;
    
    // Extract executor-specific configuration with defaults
    this.config = this.extractConfig(fullConfig);
  }

  private extractConfig(fullConfig: any): PlanExecutorConfig {
    // Extract V1 executor configuration with sensible defaults
    const planConfig = fullConfig.planExecutor || {};
    
    return {
      stepLimit: planConfig.stepLimit || 10,
      totalIterationLimit: planConfig.totalIterationLimit || 50,
      stepIterationLimit: planConfig.stepIterationLimit || 10
    };
  }

  /**
   * Stage 1 tool selection - moved from ToolSelector to V1 specific logic
   */
  async selectToolWithStage1(
    messages: any[], 
    tools: OpenAITool[], 
    config?: any, 
    projectFileStructure?: string
  ): Promise<Stage1ToolSelection | null> {
    const userMessage = messages.find(msg => msg.role === 'user');
    const userRequest = userMessage?.content || 'No user request found';
    
    this.logger.debug(`V1 Stage1: User request: "${userRequest}"`);
    this.logger.debug(`V1 Stage1: Number of tools: ${tools.length}`);

    // Get stage1 config from prompts
    const stage1Config = this.promptManager.getTemplateByPath('v1.toolSelection.stage1') as Stage1Config;
    if (!stage1Config) {
      this.logger.error('V1 Stage1: No stage1 configuration found');
      return null;
    }

    // Stage 1: Select only from read-only tools for information gathering, excluding blacklisted tools
    const readOnlyToolNames = this.toolSelector.getToolGuidanceConfig().readOnlyTools || [];
    const blacklist = this.toolSelector.getToolGuidanceConfig().toolsBlackList || [];
    const readOnlyTools = tools.filter(tool => 
      readOnlyToolNames.includes(tool.function.name) && !blacklist.includes(tool.function.name)
    );
    
    this.logger.debug(`V1 Stage1: Filtered to ${readOnlyTools.length} read-only tools from ${tools.length} total tools`);
    
    // Create mapping from normalized names (underscores) to actual tool objects
    const normalizedToolMap = new Map<string, OpenAITool>();
    readOnlyTools.forEach(tool => {
      const normalizedName = tool.function.name.replace(/-/g, '_');
      normalizedToolMap.set(normalizedName, tool);
    });
    
    const toolNames = this.toolSelector.formatToolsWithUsageHints(readOnlyTools);

    const templateVariables: Record<string, string> = {
      userRequest: userRequest,
      projectFileStructure: projectFileStructure || 'Project file structure not available',
      toolNames: toolNames
    };
    const toolSelectionPrompt = this.requestProcessor.replaceTemplateVariables(stage1Config.template, templateVariables);

    this.logger.debug(`V1 Stage1: prompt length: ${toolSelectionPrompt.length} chars`);

    try {
      // Stage 1: Select the tool using fast model
      const stage1StartTime = Date.now();
      const toolResponse = await this.ollamaClient.sendToOllama(
        toolSelectionPrompt,
        stage1Config.temperature,
        stage1Config.maxTokens,
        stage1Config.useFastModel
      );
      const cleanToolResponse = toolResponse
        .trim()
        .replace(/```json|```/g, '')
        .trim();

      this.logger.debug(`V1 Stage1: response: "${cleanToolResponse}"`);

      let toolSelection;
      try {
        toolSelection = JSON.parse(cleanToolResponse);
      } catch (parseError) {
        this.logger.error(`V1 Stage1: Failed to parse tool selection JSON: ${parseError}`, {
          response: cleanToolResponse,
        });
        return null;
      }

      if (!toolSelection.tool || toolSelection.tool === null) {
        this.logger.info('V1 Stage1: No tool selected by LLM');
        return null;
      }

      // Find the selected tool using normalized name mapping
      const selectedTool = normalizedToolMap.get(toolSelection.tool);
      if (!selectedTool) {
        this.logger.warn(`V1 Stage1: LLM selected tool not in read-only list: ${toolSelection.tool}`);
        return null;
      }

      this.logger.info(`V1 Stage1: LLM selected tool: ${toolSelection.tool} -> ${selectedTool.function.name}`);

      // Stage 2: Generate arguments using existing ToolSelector
      let argsSelection;
      const toolPrompt = toolSelection.prompt || userRequest;

      if (this.toolSelector.isSimpleArgumentGeneration(toolSelection.tool)) {
        this.logger.info('V1 Stage1: Using fast model for simple argument generation');
        argsSelection = await this.toolSelector.generateArgsWithFastModel(toolPrompt, selectedTool, projectFileStructure);
      } else {
        this.logger.info('V1 Stage1: Using full model for complex argument generation');
        argsSelection = await this.toolSelector.generateArgsWithFullModel(toolPrompt, selectedTool, projectFileStructure);
      }

      const args = argsSelection && typeof argsSelection === 'object' && 'args' in argsSelection ? argsSelection.args : argsSelection;

      return {
        tool: selectedTool.function.name,
        prompt: toolPrompt,
        args: args
      };

    } catch (error) {
      this.logger.error('V1 Stage1: Tool selection failed', { error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    }
  }

  /**
   * Determines if the response contains a plan
   */
  isPlanResponse(response: string): boolean {
    this.logger.debug('PLAN DETECTION ATTEMPT', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...',
      fullResponse: response
    });

    // Check if the response contains plan structure
    try {
      const parsed = JSON.parse(response.trim());
      const isPlan = parsed && 
             typeof parsed.main_objective === 'string' && 
             (parsed.later_steps === undefined || Array.isArray(parsed.later_steps)) &&
             (parsed.next_step === undefined || 
              (typeof parsed.next_step === 'object' && 
               parsed.next_step.tool && 
               parsed.next_step.prompt));

      this.logger.debug('PLAN DETECTION (DIRECT JSON)', {
        isPlan: isPlan,
        hasMainObjective: typeof parsed?.main_objective === 'string',
        hasLaterSteps: Array.isArray(parsed?.later_steps),
        hasValidNextStep: parsed.next_step === undefined || 
          (typeof parsed.next_step === 'object' && parsed.next_step.tool && parsed.next_step.prompt),
        parsedStructure: parsed
      });

      return isPlan;
    } catch (parseError) {
      this.logger.debug('PLAN DETECTION (DIRECT JSON FAILED)', {
        parseError: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      });

      // Try to find plan structure in text that might contain other content
      const jsonMatch = response.match(/\{[\s\S]*"main_objective"[\s\S]*\}/);
      if (jsonMatch) {
        this.logger.debug('PLAN DETECTION (EXTRACTED JSON)', {
          extractedJson: jsonMatch[0],
          jsonLength: jsonMatch[0].length
        });

        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const isPlan = parsed && 
                 typeof parsed.main_objective === 'string' && 
                 (parsed.later_steps === undefined || Array.isArray(parsed.later_steps));

          this.logger.debug('PLAN DETECTION (EXTRACTED JSON RESULT)', {
            isPlan: isPlan,
            hasMainObjective: typeof parsed?.main_objective === 'string',
            hasLaterSteps: Array.isArray(parsed?.later_steps),
            parsedStructure: parsed
          });

          return isPlan;
        } catch (extractParseError) {
          this.logger.debug('PLAN DETECTION (EXTRACTED JSON FAILED)', {
            extractParseError: extractParseError instanceof Error ? extractParseError.message : 'Unknown parse error'
          });
          return false;
        }
      }

      this.logger.debug('PLAN DETECTION (NO JSON FOUND)', {
        responseContainsMainObjective: response.includes('main_objective'),
        responseContainsPlan: response.includes('plan')
      });
      return false;
    }
  }

  /**
   * Extracts plan from response
   */
  extractPlanFromResponse(response: string): PlanResponse | null {
    this.logger.debug('PLAN EXTRACTION ATTEMPT', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...'
    });

    try {
      const parsed = JSON.parse(response.trim());
      if (this.isPlanResponse(response)) {
        this.logger.debug('PLAN EXTRACTION SUCCESS (DIRECT JSON)', {
          extractedPlan: parsed,
          objective: parsed.main_objective,
          stepsCount: parsed.later_steps?.length || 0,
          hasNextStep: !!parsed.next_step
        });
        return parsed as PlanResponse;
      }
    } catch (parseError) {
      this.logger.debug('PLAN EXTRACTION (DIRECT JSON FAILED)', {
        parseError: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      });

      // Try to extract JSON from mixed content
      const jsonMatch = response.match(/\{[\s\S]*"main_objective"[\s\S]*\}/);
      if (jsonMatch) {
        this.logger.debug('PLAN EXTRACTION (TRYING EXTRACTED JSON)', {
          extractedJsonLength: jsonMatch[0].length,
          extractedJson: jsonMatch[0]
        });

        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && 
              typeof parsed.main_objective === 'string' && 
              (parsed.later_steps === undefined || Array.isArray(parsed.later_steps))) {
            this.logger.debug('PLAN EXTRACTION SUCCESS (EXTRACTED JSON)', {
              extractedPlan: parsed,
              objective: parsed.main_objective,
              stepsCount: parsed.later_steps?.length || 0,
              hasNextStep: !!parsed.next_step
            });
            return parsed as PlanResponse;
          }
        } catch (extractParseError) {
          this.logger.debug('PLAN EXTRACTION (EXTRACTED JSON FAILED)', {
            extractParseError: extractParseError instanceof Error ? extractParseError.message : 'Unknown parse error'
          });
          return null;
        }
      }
    }

    this.logger.debug('PLAN EXTRACTION FAILED', {
      reason: 'No valid plan structure found in response'
    });
    return null;
  }

  /**
   * Handle a request (implements PlanExecutor interface)
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
    // First, check if this is a request that already has tool results (from a previous execution)
    const lastMessage = messages[messages.length - 1];
    const hasToolResults = lastMessage?.role === 'assistant' && 
                          lastMessage?.content && 
                          typeof lastMessage.content === 'object' && 
                          'tool' in lastMessage.content;

    if (!hasToolResults) {
      // No tool results yet, need to do tool selection and execution first
      const projectFileStructure = await projectFileStructureGetter();
      const toolSelection = await this.selectToolWithStage1(messages, tools, undefined, projectFileStructure);
      
      if (toolSelection) {
        this.logger.info(`Processing tool selection: ${toolSelection.tool}`);

        // Check if this is a safe tool that can be auto-executed
        if (this.toolSelector.isSafeTool(toolSelection.tool)) {
          this.logger.info(`Auto-executing safe tool: ${toolSelection.tool}`);

          try {
            // Execute the tool automatically
            const toolResult = await this.mcpManager.callMCPTool(
              toolSelection.tool,
              toolSelection.args
            );
            this.logger.info('Tool executed successfully', { resultLength: toolResult.length });

            // Create messages with tool result for decision making
            const messagesWithTool = [
              ...messages,
              {
                role: 'assistant',
                content: {
                  tool: toolSelection.tool,
                  prompt: toolSelection.prompt,
                  args: JSON.stringify(toolSelection.args),
                  results: toolResult
                }
              }
            ];

            // Recursively call handleRequest with tool results
            return this.handleRequest(
              messagesWithTool,
              res,
              temperature,
              maxTokens,
              tools,
              projectFileStructureGetter,
              defaultTemperature,
              defaultMaxTokens
            );

          } catch (toolError) {
            this.logger.error('Tool execution failed:', toolError);

            // Treat the error as a tool result so the conversation can continue
            const errorMessage = `Error executing tool "${toolSelection.tool}": ${toolError instanceof Error ? toolError.message : 'Unknown error'}`;
            
            const messagesWithTool = [
              ...messages,
              {
                role: 'assistant',
                content: {
                  tool: toolSelection.tool,
                  prompt: toolSelection.prompt,
                  args: JSON.stringify(toolSelection.args),
                  results: errorMessage
                }
              }
            ];

            // Recursively call handleRequest with error result
            return this.handleRequest(
              messagesWithTool,
              res,
              temperature,
              maxTokens,
              tools,
              projectFileStructureGetter,
              defaultTemperature,
              defaultMaxTokens
            );
          }
        } else {
          // Ask for permission for potentially unsafe tools
          this.logger.info(`Asking permission for potentially unsafe tool: ${toolSelection.tool}`);
          
          const permissionMessage = `I'd like to use the ${toolSelection.tool} tool with these parameters: ${JSON.stringify(toolSelection.args)}. This tool may modify files or system state. Would you like me to proceed? (Please respond with 'yes' to continue or 'no' to cancel)`;

          this.requestProcessor.sendStreamingResponse(res, permissionMessage);
          return;
        }
      }
      
      // No tool selection made, fall through to normal response generation
    }

    // Generate response (either with tool results or without)
    const response = await this.generateResponseWithToolResults(
      messages,
      temperature,
      maxTokens,
      tools,
      await projectFileStructureGetter()
    );

    // Try to handle as plan, if not a plan then stream normal response
    const planHandled = await this.handleResponseOrPlan(
      response,
      messages,
      res,
      temperature,
      maxTokens,
      projectFileStructureGetter,
      defaultTemperature,
      defaultMaxTokens
    );

    if (!planHandled) {
      this.requestProcessor.sendStreamingResponse(res, response);
    }
  }

  /**
   * Handle response - detect if it's a plan and execute if so
   * Returns true if a plan was detected and executed, false otherwise
   */
  async handleResponseOrPlan(
    response: string,
    originalMessages: any[],
    res: any,
    temperature: number,
    maxTokens: number,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<boolean> {
    if (this.isPlanResponse(response)) {
      const plan = this.extractPlanFromResponse(response);
      if (plan && plan.next_step) {
        this.logger.info('Plan detected by V1 executor, starting execution', {
          objective: plan.main_objective,
          stepsCount: plan.later_steps?.length || 0
        });

        await this.executePlan(
          originalMessages,
          plan,
          temperature,
          maxTokens,
          res,
          projectFileStructureGetter,
          defaultTemperature,
          defaultMaxTokens
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Executes a plan with the V1 iteration logic
   */
  async executePlan(
    originalMessages: any[],
    initialPlan: PlanResponse,
    temperature: number,
    maxTokens: number,
    res: any,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<void> {
    const streamContext = this.streamPlanResponse(res, initialPlan);
    
    let executionState = this.initializeExecutionState(originalMessages, initialPlan);
    
    let totalIterationCount = 0;
    let stepIterationCount = 0;

    this.logger.debug('PLAN EXECUTION LOOP START', {
      stepLimit: this.config.stepLimit,
      totalIterationLimit: this.config.totalIterationLimit,
      stepIterationLimit: this.config.stepIterationLimit,
      hasNextStep: !!initialPlan.next_step
    });

    while (executionState.currentStep && 
           executionState.completedSteps.length <= this.config.stepLimit && 
           totalIterationCount < this.config.totalIterationLimit && 
           stepIterationCount < this.config.stepIterationLimit) {
      
      totalIterationCount++;
      stepIterationCount++;
      
      this.logger.info(`Executing plan iteration ${totalIterationCount} (step iteration ${stepIterationCount}): ${executionState.currentStep.objective}`);

      try {
        // Execute current step
        const toolResult = await this.executeStep(executionState, originalMessages, projectFileStructureGetter);
        
        // Select and build prompt
        const { prompt, promptConfig } = await this.selectAndBuildPrompt(
          executionState,
          originalMessages,
          totalIterationCount,
          stepIterationCount,
          projectFileStructureGetter
        );

        // Get response from model
        const promptParams = this.getPromptParameters(
          promptConfig,
          temperature,
          maxTokens,
          defaultTemperature,
          defaultMaxTokens
        );
        
        const response = await this.ollamaClient.sendToOllama(
          prompt,
          promptParams.temperature,
          promptParams.maxTokens
        );

        // Handle response based on prompt type
        if (this.isFinalIteration(totalIterationCount, stepIterationCount)) {
          this.streamFinalConclusion(res, response, streamContext);
          break;
        }

        // Process iteration response
        const action = await this.processIterationResponse(
          response,
          executionState,
          stepIterationCount,
          res,
          streamContext,
          originalMessages,
          temperature,
          maxTokens,
          projectFileStructureGetter,
          defaultTemperature,
          defaultMaxTokens
        );

        if (action === 'break') {
          break;
        } else if (action === 'reset_step_counter') {
          stepIterationCount = 0;
        }

      } catch (error) {
        this.logger.error(`Error executing plan step: ${error}`);
        
        // Check if this is a tool selection/argument generation error
        if (error instanceof Error && error.message.includes('Tool argument generation failed')) {
          await this.handleEmergencyConclusion(
            executionState,
            error.message,
            originalMessages,
            res,
            temperature,
            maxTokens,
            projectFileStructureGetter,
            defaultTemperature,
            defaultMaxTokens
          );
        } else {
          const errorMessage = `Error in step "${executionState.currentStep!.objective}": ${error instanceof Error ? error.message : 'Unknown error'}`;
          this.streamFinalConclusion(res, errorMessage, streamContext);
        }
        break;
      }
    }

    this.logger.debug('PLAN EXECUTION LOOP END', {
      totalIterationCount,
      stepIterationCount,
      completedStepsCount: executionState.completedSteps.length
    });
  }

  private initializeExecutionState(originalMessages: any[], initialPlan: PlanResponse): PlanExecutionState {
    const initialCompletedSteps: CompletedStepRequest[] = [];
    
    if (initialPlan.conclusion_from_junior_assistant_data || initialPlan.junior_assistant_data_was_helpful !== undefined) {
      const initialToolCall = originalMessages.find((msg: any) => 
        msg.role === 'assistant' && typeof msg.content === 'object' && msg.content.tool
      );
      
      const toolCalls = [];
      if (initialToolCall) {
        const assistantResult = initialToolCall.content as any;
        toolCalls.push({
          prompt: assistantResult.prompt,
          tool: assistantResult.tool,
          args: assistantResult.args
        });
      }

      initialCompletedSteps.push({
        objective: "Assistant gathers initial information",
        success: initialPlan.junior_assistant_data_was_helpful || false,
        conclusion: initialPlan.conclusion_from_junior_assistant_data || "No conclusion provided from assistant data",
        toolCalls: toolCalls
      });
    }
    
    return {
      objective: initialPlan.main_objective,
      completedSteps: initialCompletedSteps,
      currentStep: initialPlan.next_step,
      currentStepNotes: undefined,
      currentStepAssistant: undefined,
      currentStepToolCalls: [],
      laterSteps: initialPlan.later_steps || [],
      stepResults: []
    };
  }

  private async executeStep(
    executionState: PlanExecutionState,
    originalMessages: any[],
    projectFileStructureGetter: () => Promise<string>
  ): Promise<string> {
    const availableMcpTools = this.mcpManager.getOpenAITools();
    const currentTool = availableMcpTools.find(tool => 
      tool.function.name === executionState.currentStep!.tool
    );

    let toolResult: string;
    let actualArgs: any = {};

    if (!currentTool) {
      this.logger.error(`Tool not found: ${executionState.currentStep!.tool}`);
      toolResult = `Error: Tool "${executionState.currentStep!.tool}" does not exist. Available tools: ${availableMcpTools.map(t => t.function.name).join(', ')}`;
    } else {
      try {
        const stepPrompt = [
          ...originalMessages,
          { role: 'user', content: executionState.currentStep!.prompt }
        ];

        const userRequest = executionState.currentStep!.prompt;
        const isSimpleArg = this.toolSelector.isSimpleArgumentGeneration(executionState.currentStep!.tool);
        const projectFileStructure = await projectFileStructureGetter();

        let toolArgs;
        try {
          if (isSimpleArg) {
            toolArgs = await this.toolSelector.generateArgsWithFastModel(userRequest, currentTool, projectFileStructure);
          } else {
            toolArgs = await this.toolSelector.generateArgsWithFullModel(userRequest, currentTool, projectFileStructure);
          }
        } catch (toolSelectionError) {
          this.logger.error(`Tool argument generation failed: ${toolSelectionError instanceof Error ? toolSelectionError.message : 'Unknown error'}`);
          throw new Error(`Tool argument generation failed: ${toolSelectionError instanceof Error ? toolSelectionError.message : 'Unknown error'}`);
        }

        actualArgs = toolArgs && typeof toolArgs === 'object' && 'args' in toolArgs ? toolArgs.args : toolArgs;

        toolResult = await this.mcpManager.callMCPTool(
          executionState.currentStep!.tool,
          actualArgs
        );
      } catch (toolError) {
        this.logger.error(`Error executing tool ${executionState.currentStep!.tool}:`, toolError);
        toolResult = `Error executing tool "${executionState.currentStep!.tool}": ${toolError instanceof Error ? toolError.message : 'Unknown error'}`;
      }
    }

    // Store assistant tool result
    executionState.currentStepAssistant = {
      tool: executionState.currentStep!.tool,
      prompt: executionState.currentStep!.prompt,
      args: JSON.stringify(actualArgs),
      results: toolResult
    };

    executionState.currentStepToolCalls.push({
      prompt: executionState.currentStep!.prompt,
      tool: executionState.currentStep!.tool,
      args: JSON.stringify(actualArgs)
    });

    return toolResult;
  }

  private async selectAndBuildPrompt(
    executionState: PlanExecutionState,
    originalMessages: any[],
    totalIterationCount: number,
    stepIterationCount: number,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>
  ): Promise<{ prompt: string; promptConfig: any }> {
    const userMessage = originalMessages.find(msg => msg.role === 'user');
    const userPrompt = userMessage ? userMessage.content : 'No user prompt available';
    const projectFileStructure = await projectFileStructureGetter(true); // Force refresh for plan iteration
    const systemPrompt = this.promptManager.getTemplateString('systemMessages.customSystemPrompt')!;

    // Select appropriate prompt template
    if (this.isFinalIteration(totalIterationCount, stepIterationCount)) {
      return this.buildFinalIterationPrompt(executionState, userPrompt, projectFileStructure, systemPrompt);
    } else if (this.isStepLimitIteration(executionState)) {
      return this.buildStepLimitIterationPrompt(executionState, userPrompt, projectFileStructure, systemPrompt);
    } else {
      return this.buildPlanIterationPrompt(executionState, userPrompt, projectFileStructure, systemPrompt);
    }
  }

  private buildFinalIterationPrompt(
    executionState: PlanExecutionState,
    userPrompt: string,
    projectFileStructure: string,
    systemPrompt: string
  ): { prompt: string; promptConfig: any } {
    const completedStepsText = this.formatCompletedStepsWithTemplates(executionState.completedSteps);
    
    const templateVariables: Record<string, string> = {
      systemPrompt,
      projectFileStructure,
      userPrompt,
      objective: executionState.objective,
      completedSteps: completedStepsText
    };
    
    const promptTemplate = this.promptManager.getTemplateString('responseGeneration.finalIteration')!;
    const prompt = this.requestProcessor.replaceTemplateVariables(
      promptTemplate,
      templateVariables
    );
    
    return { prompt, promptConfig: this.promptManager.getTemplateWithParams('responseGeneration.finalIteration') };
  }

  private buildStepLimitIterationPrompt(
    executionState: PlanExecutionState,
    userPrompt: string,
    projectFileStructure: string,
    systemPrompt: string
  ): { prompt: string; promptConfig: any } {
    const completedStepsText = this.formatCompletedStepsWithTemplates(executionState.completedSteps);
    const currentStepText = this.formatCurrentStep(executionState);
    const nextStepsText = this.formatNextSteps(executionState.laterSteps);
    const toolNamesAndHints = this.getToolNamesAndHints();
    
    const templateVariables: Record<string, string> = {
      systemPrompt,
      projectFileStructure,
      userPrompt,
      objective: executionState.objective,
      completedSteps: completedStepsText,
      currentStep: currentStepText,
      nextSteps: nextStepsText,
      toolNamesAndHints
    };
    
    const template = this.promptManager.getTemplateString('responseGeneration.stepLimitIteration');
    if (template) {
      const prompt = this.requestProcessor.replaceTemplateVariables(template, templateVariables);
      return { prompt, promptConfig: this.promptManager.getTemplateWithParams('responseGeneration.stepLimitIteration') };
    } else {
      // Fallback to finalIteration
      return this.buildFinalIterationPrompt(executionState, userPrompt, projectFileStructure, systemPrompt);
    }
  }

  private buildPlanIterationPrompt(
    executionState: PlanExecutionState,
    userPrompt: string,
    projectFileStructure: string,
    systemPrompt: string
  ): { prompt: string; promptConfig: any } {
    const completedStepsText = this.formatCompletedStepsWithTemplates(executionState.completedSteps);
    const currentStepText = this.formatCurrentStep(executionState);
    const nextStepsText = this.formatNextSteps(executionState.laterSteps);
    const toolNamesAndHints = this.getToolNamesAndHints();
    
    const templateVariables: Record<string, string> = {
      systemPrompt,
      projectFileStructure,
      userPrompt,
      objective: executionState.objective,
      completedSteps: completedStepsText,
      currentStep: currentStepText,
      nextSteps: nextStepsText,
      toolNamesAndHints
    };
    
    const promptTemplate = this.promptManager.getTemplateString('responseGeneration.planIteration')!;
    const prompt = this.requestProcessor.replaceTemplateVariables(
      promptTemplate,
      templateVariables
    );
    
    return { prompt, promptConfig: this.promptManager.getTemplateWithParams('responseGeneration.planIteration') };
  }

  private formatCurrentStep(executionState: PlanExecutionState): string {
    const currentStepRequest = {
      objective: executionState.currentStep?.objective || 'No current step',
      completed: false,
      notes: executionState.currentStepNotes || '',
      assistant: executionState.currentStepAssistant || {
        tool: 'none',
        prompt: 'No tool executed yet',
        args: '{}',
        results: 'No results yet'
      }
    };
    
    const notesLine = currentStepRequest.notes && currentStepRequest.notes.trim() || "*No notes yet*";
    
    const previousToolTemplate = this.promptManager.getTemplateString('responseGeneration.previousTool')!;
    const previousToolCalls = executionState.currentStepToolCalls.slice(0, -1);
    const previousToolList = previousToolCalls.map(toolCall => {
      const toolVariables: Record<string, string> = {
        prompt: toolCall.prompt,
        tool: toolCall.tool,
        args: toolCall.args
      };
      return this.requestProcessor.replaceTemplateVariables(previousToolTemplate, toolVariables);
    }).join('\n');
    
    const currentStepTemplate = this.promptManager.getTemplateString('responseGeneration.currentStep')!;
    const currentStepNumber = executionState.completedSteps.length + 1;
    const currentStepVariables: Record<string, string> = {
      stepNumber: currentStepNumber.toString(),
      objective: currentStepRequest.objective,
      notes: notesLine,
      previousToolList: previousToolList,
      tool: currentStepRequest.assistant.tool,
      prompt: currentStepRequest.assistant.prompt,
      args: currentStepRequest.assistant.args,
      results: this.requestProcessor.formatToolResultsAsBlockQuote(currentStepRequest.assistant.results)
    };
    
    return this.requestProcessor.replaceTemplateVariables(currentStepTemplate, currentStepVariables);
  }

  private formatNextSteps(laterSteps: string[]): string {
    return laterSteps.length > 0
      ? laterSteps.map((step) => `- ${step}`).join('\n')
      : 'None';
  }

  private getToolNamesAndHints(): string {
    const iterationMcpTools = this.mcpManager.getOpenAITools();
    return this.toolSelector.formatToolsWithUsageHints(iterationMcpTools);
  }

  private async processIterationResponse(
    response: string,
    executionState: PlanExecutionState,
    stepIterationCount: number,
    res: any,
    streamContext: any,
    originalMessages: any[],
    temperature: number,
    maxTokens: number,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<'continue' | 'break' | 'reset_step_counter'> {
    const iterationResponse = this.parseIterationResponse(response);
    
    if (iterationResponse === null) {
      // Malformed response
      this.streamFinalConclusion(res, 'Plan execution ended due to malformed response.', streamContext);
      return 'break';
    }
    
    if (typeof iterationResponse === 'string') {
      // Final conclusion reached
      this.streamFinalConclusion(res, iterationResponse, streamContext);
      return 'break';
    }
    
    if ('completed' in iterationResponse.current_step) {
      // Step completed
      const stepCompleteResponse = iterationResponse as CurrentStepCompleteResponse;
      
      if (!stepCompleteResponse.next_step) {
        this.streamFinalConclusion(res, stepCompleteResponse.current_step.notes_to_future_self, streamContext);
        return 'break';
      }
      
      // Update execution state
      if (executionState.currentStep) {
        const completedStep: CompletedStepRequest = {
          objective: executionState.currentStep.objective,
          success: stepCompleteResponse.current_step.success,
          conclusion: stepCompleteResponse.current_step.notes_to_future_self,
          toolCalls: executionState.currentStepToolCalls
        };
        executionState.completedSteps.push(completedStep);
      }
      
      // Check if we've reached the step limit
      if (executionState.completedSteps.length >= this.config.stepLimit) {
        // Handle step limit reached
        await this.handleStepLimitReached(
          executionState,
          stepCompleteResponse,
          res,
          streamContext,
          originalMessages,
          temperature,
          maxTokens,
          projectFileStructureGetter,
          defaultTemperature,
          defaultMaxTokens
        );
        return 'break';
      }
      
      // Set the next step as current
      executionState.currentStep = {
        objective: stepCompleteResponse.next_step.objective,
        tool: stepCompleteResponse.next_step.tool,
        prompt: stepCompleteResponse.next_step.prompt
      };
      executionState.currentStepNotes = undefined;
      executionState.currentStepAssistant = undefined;
      executionState.currentStepToolCalls = [];
      
      this.streamStepCompletion(
        res,
        stepCompleteResponse.current_step.notes_to_future_self,
        executionState.currentStep,
        streamContext
      );
      
      return 'reset_step_counter';
      
    } else {
      // Continue working on current step
      const stepIterationResponse = iterationResponse as CurrentStepIterationResponse;
      
      if (executionState.currentStep) {
        executionState.currentStep.tool = stepIterationResponse.current_step.tool;
        executionState.currentStep.prompt = stepIterationResponse.current_step.prompt;
      }
      
      if (executionState.currentStepNotes) {
        executionState.currentStepNotes += '\n\n' + stepIterationResponse.current_step.notes_to_future_self;
      } else {
        executionState.currentStepNotes = stepIterationResponse.current_step.notes_to_future_self;
      }
      
      this.streamStepCompletion(
        res,
        stepIterationResponse.current_step.notes_to_future_self,
        undefined,
        streamContext
      );
      
      return 'continue';
    }
  }

  private async handleStepLimitReached(
    executionState: PlanExecutionState,
    stepCompleteResponse: CurrentStepCompleteResponse,
    res: any,
    streamContext: any,
    originalMessages: any[],
    temperature: number,
    maxTokens: number,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<void> {
    this.logger.debug('PLAN STEP LIMIT REACHED', {
      completedStepsCount: executionState.completedSteps.length,
      stepLimit: this.config.stepLimit,
      ignoringNextStep: stepCompleteResponse.next_step
    });
    
    // Stream step completion without next step header
    this.streamStepCompletion(
      res,
      stepCompleteResponse.current_step.notes_to_future_self,
      undefined,
      streamContext
    );
    
    // Send final iteration prompt
    const { prompt } = await this.buildFinalIterationPrompt(
      executionState,
      originalMessages.find(msg => msg.role === 'user')?.content || 'No user prompt available',
      await projectFileStructureGetter(true), // Force refresh before final iteration
      this.promptManager.getTemplateString('systemMessages.customSystemPrompt') || ''
    );
    
    const finalPromptParams = this.getPromptParameters(
      this.promptManager.getTemplateWithParams('responseGeneration.finalIteration'),
      temperature,
      maxTokens,
      defaultTemperature,
      defaultMaxTokens
    );
    
    const finalResponse = await this.ollamaClient.sendToOllama(
      prompt,
      finalPromptParams.temperature,
      finalPromptParams.maxTokens
    );
    
    this.streamFinalConclusion(res, finalResponse, streamContext);
  }

  private isFinalIteration(totalIterationCount: number, stepIterationCount: number): boolean {
    return totalIterationCount >= this.config.totalIterationLimit || 
           stepIterationCount >= this.config.stepIterationLimit;
  }

  private isStepLimitIteration(executionState: PlanExecutionState): boolean {
    return executionState.completedSteps.length >= this.config.stepLimit;
  }

  private getPromptParameters(
    promptConfig: { temperature?: number; maxTokens?: number } | undefined,
    requestTemperature: number,
    requestMaxTokens: number,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): { temperature: number; maxTokens: number } {
    const temperature = promptConfig?.temperature ?? 
                       defaultTemperature ?? 
                       requestTemperature;
                       
    const maxTokens = promptConfig?.maxTokens ?? 
                     defaultMaxTokens ?? 
                     requestMaxTokens;
    
    return { temperature, maxTokens };
  }

  /**
   * Format completed steps using templates from prompts.json (moved from RequestProcessor)
   */
  formatCompletedStepsWithTemplates(completedSteps: CompletedStepRequest[]): string {
    if (completedSteps.length === 0) {
      return 'None';
    }

    const previousToolTemplate = this.promptManager.getTemplateString('responseGeneration.previousTool')!;
    const previousStepTemplate = this.promptManager.getTemplateString('responseGeneration.previousStep')!;

    return completedSteps.map((step, i) => {
      // Format all tool calls for this step
      const previousToolList = step.toolCalls.map(toolCall => {
        const toolVariables: Record<string, string> = {
          prompt: toolCall.prompt,
          tool: toolCall.tool,
          args: toolCall.args
        };
        return this.requestProcessor.replaceTemplateVariables(previousToolTemplate, toolVariables);
      }).join('\n');

      // Format the step using previousStep template
      const stepVariables: Record<string, string> = {
        stepNumber: (i + 1).toString(),
        objective: step.objective,
        success: step.success ? 'Yes' : 'No',
        previousToolList: previousToolList,
        conclusion: step.conclusion
      };

      return this.requestProcessor.replaceTemplateVariables(previousStepTemplate, stepVariables);
    }).join('\n\n');
  }

  /**
   * Generate response using plan decision template (moved from RequestProcessor)
   */
  async generateResponseWithToolResults(
    messages: any[],
    temperature: number,
    maxTokens: number,
    tools?: OpenAITool[],
    projectFileStructure?: string
  ): Promise<string> {
    // Get the plan decision template
    const planDecisionTemplate = this.promptManager.getTemplateString('responseGeneration.planDecision')!;
    
    // Extract userPrompt from messages
    const userMessage = messages.find(msg => msg.role === 'user');
    const userPrompt = userMessage ? userMessage.content : 'No user prompt available';
    
    // Create assistantContext from assistant tool usage using template
    const assistantMessages = messages.filter(msg => msg.role === 'assistant');
    const planDecisionAssistantTemplate = this.promptManager.getTemplateString('responseGeneration.planDecisionAssistant')!;

    const assistantContext = assistantMessages.map(msg => {
      if (typeof msg.content === 'object' && msg.content.tool) {
        const assistantResult = msg.content as AssistantToolResult;
        const formattedResults = this.requestProcessor.formatToolResultsAsBlockQuote(assistantResult.results);
        
        const assistantVariables: Record<string, string> = {
          prompt: assistantResult.prompt,
          tool: assistantResult.tool,
          args: assistantResult.args,
          results: formattedResults
        };
        
        return this.requestProcessor.replaceTemplateVariables(planDecisionAssistantTemplate, assistantVariables);
      }
      return msg.content;
    }).join('\n\n');
    
    // Prepare template variables
    const templateVariables: Record<string, string> = {
      systemPrompt: this.promptManager.getTemplateString('systemMessages.customSystemPrompt')!,
      projectFileStructure: projectFileStructure || '',
      userPrompt: userPrompt,
      planDecisionAssistant: assistantContext
    };
    
    // Add tools if provided
    if (tools && tools.length > 0) {
      templateVariables.toolNamesAndHints = this.toolSelector.formatToolsWithUsageHints(tools);
    } else {
      // Remove the tools section from template if no tools provided
      templateVariables.toolNamesAndHints = '';
    }
    
    // Replace all template variables
    let prompt = this.requestProcessor.replaceTemplateVariables(planDecisionTemplate, templateVariables);
    
    // Remove empty sections (like the tools section when no tools are provided)
    prompt = prompt.replace('\n\nAvailable tools:\n\n', '');

    // Debug logging: Final response generation prompt
    this.logger.debug('PLAN DECISION PROMPT (TOOL RESULTS)', {
      originalMessageCount: messages.length,
      finalPrompt: prompt,
      promptLength: prompt.length,
      temperature: temperature,
      maxTokens: maxTokens,
      toolsProvided: tools ? tools.length : 0,
      hasProjectFileStructure: !!projectFileStructure
    });

    return await this.ollamaClient.sendToOllama(prompt, temperature, maxTokens);
  }

  /**
   * Parse iteration response (moved from RequestProcessor)
   */
  parseIterationResponse(response: string): CurrentStepIterationResponse | CurrentStepCompleteResponse | string | null {
    this.logger.debug('ITERATION RESPONSE PARSING ATTEMPT', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...'
    });

    try {
      const parsed = JSON.parse(response.trim());
      
      // Check for Option A: continue_with_current_step
      if (parsed.continue_with_current_step) {
        const continueStep = parsed.continue_with_current_step;
        const iterationResponse: CurrentStepIterationResponse = {
          current_step: {
            notes_to_future_self: continueStep.notes_to_future_self || '',
            tool: continueStep.tool,
            prompt: continueStep.prompt
          },
          later_steps: parsed.later_steps
        };
        
        this.logger.debug('ITERATION RESPONSE: Continue with current step (Option A)', {
          response: iterationResponse
        });
        
        return iterationResponse;
      }
      
      // Check for Option B: wrap_up_current_step + new_step
      if (parsed.wrap_up_current_step && parsed.new_step) {
        const wrapUp = parsed.wrap_up_current_step;
        const newStep = parsed.new_step;
        const completeResponse: CurrentStepCompleteResponse = {
          current_step: {
            completed: true,
            success: wrapUp.success || false,
            notes_to_future_self: wrapUp.notes_to_future_self || ''
          },
          next_step: {
            objective: newStep.objective,
            tool: newStep.tool,
            prompt: newStep.prompt
          },
          later_steps: parsed.later_steps
        };
        
        this.logger.debug('ITERATION RESPONSE: Wrap up current step and start new (Option B)', {
          response: completeResponse,
          hasNextStep: true
        });
        
        return completeResponse;
      }
      
      // If neither pattern matches, treat as final conclusion
      this.logger.debug('ITERATION RESPONSE: JSON parsed but no expected structure found, treating as final conclusion', {
        parsedStructure: parsed
      });
      return response.trim();
      
    } catch (parseError) {
      this.logger.debug('ITERATION RESPONSE (DIRECT JSON FAILED)', {
        parseError: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      });

      // Try to extract JSON from markdown code blocks
      const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        this.logger.debug('ITERATION RESPONSE (EXTRACTED JSON FROM MARKDOWN)', {
          extractedJson: jsonMatch[1],
          jsonLength: jsonMatch[1].length
        });

        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          
          // Check for Option A: continue_with_current_step
          if (parsed.continue_with_current_step) {
            const continueStep = parsed.continue_with_current_step;
            const iterationResponse: CurrentStepIterationResponse = {
              current_step: {
                notes_to_future_self: continueStep.notes_to_future_self || '',
                tool: continueStep.tool,
                prompt: continueStep.prompt
              },
              later_steps: parsed.later_steps
            };
            
            this.logger.debug('ITERATION RESPONSE: Continue with current step (Option A) (from markdown)', {
              response: iterationResponse
            });
            
            return iterationResponse;
          }
          
          // Check for Option B: wrap_up_current_step + new_step
          if (parsed.wrap_up_current_step && parsed.new_step) {
            const wrapUp = parsed.wrap_up_current_step;
            const newStep = parsed.new_step;
            const completeResponse: CurrentStepCompleteResponse = {
              current_step: {
                completed: true,
                success: wrapUp.success || false,
                notes_to_future_self: wrapUp.notes_to_future_self || ''
              },
              next_step: {
                objective: newStep.objective,
                tool: newStep.tool,
                prompt: newStep.prompt
              },
              later_steps: parsed.later_steps
            };
            
            this.logger.debug('ITERATION RESPONSE: Wrap up current step and start new (Option B) (from markdown)', {
              response: completeResponse,
              hasNextStep: true
            });
            
            return completeResponse;
          }
          
          // If neither pattern matches, treat as final conclusion
          this.logger.debug('ITERATION RESPONSE: JSON from markdown parsed but no expected structure found, treating as final conclusion', {
            parsedStructure: parsed
          });
          return response.trim();
          
        } catch (extractParseError) {
          this.logger.debug('ITERATION RESPONSE (EXTRACTED JSON FAILED)', {
            extractParseError: extractParseError instanceof Error ? extractParseError.message : 'Unknown parse error'
          });
        }
      }

      // Not JSON and no extractable JSON, treat as final conclusion (Option 3)
      this.logger.debug('ITERATION RESPONSE: Final conclusion (non-JSON)', {
        parseError: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      });
      return response.trim();
    }
  }

  /**
   * Stream plan response to Continue (moved from RequestProcessor)
   */
  streamPlanResponse(res: any, plan: PlanResponse, model?: string): { id: string, created: number, responseModel: string } {
    this.logger.info('Streaming plan response to Continue');
    this.logger.debug('PLAN STREAMING DETAILS', {
      plan: plan,
      objective: plan.main_objective,
      laterStepsCount: plan.later_steps?.length || 0,
      hasNextStep: !!plan.next_step,
      nextStepTool: plan.next_step?.tool,
      nextStepObjective: plan.next_step?.objective,
      model: model
    });

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });

    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const responseModel = model || 'default-model';

    this.logger.debug('PLAN STREAMING SSE SETUP', {
      streamId: id,
      created: created,
      responseModel: responseModel
    });

    // Stream plan introduction
    const planIntro = `A plan has been created where the objective is: ${plan.main_objective}\n\n`;
    this.logger.debug('PLAN STREAMING INTRO', {
      content: planIntro,
      length: planIntro.length
    });
    this.requestProcessor.streamChunk(res, planIntro, id, created, responseModel);

    // Stream plan steps
    if (plan.later_steps && plan.later_steps.length > 0) {
      plan.later_steps.forEach((step: string, index: number) => {
        const stepText = `- ${step}\n`;
        this.logger.debug('PLAN STREAMING STEP', {
          stepIndex: index,
          stepContent: stepText,
          stepLength: stepText.length
        });
        this.requestProcessor.streamChunk(res, stepText, id, created, responseModel);
      });
    }

    // Stream current step if present
    if (plan.next_step) {
      const stepHeader = `\n${plan.next_step.objective}\n${'-'.repeat(plan.next_step.objective.length)}\n`;
      this.logger.debug('PLAN STREAMING NEXT STEP HEADER', {
        stepHeader: stepHeader,
        headerLength: stepHeader.length,
        nextStepDetails: plan.next_step
      });
      this.requestProcessor.streamChunk(res, stepHeader, id, created, responseModel);
    }

    this.logger.debug('PLAN STREAMING COMPLETION', {
      totalContentEstimate: planIntro.length + 100,
      note: 'Stream kept open for plan execution'
    });
    // Don't finish the stream - keep it open for plan execution
    // Return stream context for continued streaming
    return { id, created, responseModel };
  }

  /**
   * Stream step completion (moved from RequestProcessor)
   */
  streamStepCompletion(res: any, stepResult: string, nextStep?: NextStepResponse, streamContext?: { id: string, created: number, responseModel: string }): void {
    this.logger.debug('STEP COMPLETION STREAMING START', {
      stepResult: stepResult,
      stepResultLength: stepResult.length,
      hasNextStep: !!nextStep,
      nextStep: nextStep,
      streamContext: streamContext
    });

    // Use existing stream context or create new one
    const id = streamContext?.id || `chatcmpl-${Date.now()}`;
    const created = streamContext?.created || Math.floor(Date.now() / 1000);
    const responseModel = streamContext?.responseModel || 'default-model';

    // Stream step completion
    if (stepResult) {
      const completionText = stepResult + '\n\n';
      this.logger.debug('STEP COMPLETION STREAMING RESULT', {
        completionText: completionText,
        completionLength: completionText.length
      });
      this.requestProcessor.streamChunk(res, completionText, id, created, responseModel);
    }

    // Stream next step if present
    if (nextStep) {
      const stepHeader = `${nextStep.objective}\n${'-'.repeat(nextStep.objective.length)}\n`;
      this.logger.debug('STEP COMPLETION STREAMING NEXT STEP', {
        stepHeader: stepHeader,
        headerLength: stepHeader.length,
        nextStepDetails: nextStep
      });
      this.requestProcessor.streamChunk(res, stepHeader, id, created, responseModel);
    }

    this.logger.debug('STEP COMPLETION STREAMING END');
  }

  /**
   * Stream final conclusion (moved from RequestProcessor)
   */
  streamFinalConclusion(res: any, conclusion: string, streamContext?: { id: string, created: number, responseModel: string }): void {
    this.logger.debug('FINAL CONCLUSION STREAMING START', {
      conclusion: conclusion,
      conclusionLength: conclusion.length,
      streamContext: streamContext
    });

    const id = streamContext?.id || `chatcmpl-${Date.now()}`;
    const created = streamContext?.created || Math.floor(Date.now() / 1000);
    const responseModel = streamContext?.responseModel || 'default-model';

    const header = `\nFinal conclusion reached\n${'='.repeat(25)}\n\n`;
    this.logger.debug('FINAL CONCLUSION STREAMING HEADER', {
      header: header,
      headerLength: header.length
    });
    this.requestProcessor.streamChunk(res, header, id, created, responseModel);

    this.logger.debug('FINAL CONCLUSION STREAMING CONTENT', {
      conclusion: conclusion,
      conclusionLength: conclusion.length
    });
    this.requestProcessor.streamChunk(res, conclusion, id, created, responseModel);

    this.logger.debug('FINAL CONCLUSION STREAMING END', {
      totalEstimate: conclusion.length + 50
    });
    this.requestProcessor.finishStream(res, id, created, responseModel, conclusion.length + 50);
  }

  /**
   * Handle emergency conclusion when tool errors occur
   */
  async handleEmergencyConclusion(
    executionState: PlanExecutionState,
    errorString: string,
    originalMessages: any[],
    res: any,
    temperature: number,
    maxTokens: number,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<void> {
    this.logger.warn('Handling emergency conclusion due to error', { error: errorString });
    
    const userMessage = originalMessages.find(msg => msg.role === 'user');
    const userPrompt = userMessage ? userMessage.content : 'No user prompt available';
    const projectFileStructure = await projectFileStructureGetter(true);
    const systemPrompt = this.promptManager.getTemplateString('systemMessages.customSystemPrompt')!;
    
    // Build error conclusion prompt
    const completedStepsText = this.formatCompletedStepsWithTemplates(executionState.completedSteps);
    const currentStepText = this.formatCurrentStep(executionState);
    
    const templateVariables: Record<string, string> = {
      systemPrompt,
      projectFileStructure,
      userPrompt,
      errorString,
      objective: executionState.objective,
      completedSteps: completedStepsText,
      currentStep: currentStepText
    };
    
    const promptTemplate = this.promptManager.getTemplateString('responseGeneration.errorConclusion')!;
    const prompt = this.requestProcessor.replaceTemplateVariables(
      promptTemplate,
      templateVariables
    );
    
    const promptParams = this.getPromptParameters(
      this.promptManager.getTemplateWithParams('responseGeneration.errorConclusion'),
      temperature,
      maxTokens,
      defaultTemperature,
      defaultMaxTokens
    );
    
    const response = await this.ollamaClient.sendToOllama(
      prompt,
      promptParams.temperature,
      promptParams.maxTokens
    );
    
    // Use the existing stream context from main execution flow
    // For emergency conclusions, we'll stream the response directly
    this.streamFinalConclusion(res, response, { 
      id: 'emergency-conclusion', 
      created: Date.now(), 
      responseModel: 'emergency' 
    });
  }
}