import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { ToolSelector } from './tool-selector';
import { MCPManager, OpenAITool } from './mcp-manager';
import { PromptManager } from './prompt-manager';
import { 
  RequestProcessor, 
  PlanResponse, 
  PlanExecutionState, 
  CompletedStepRequest,
  CurrentStepIterationResponse,
  CurrentStepCompleteResponse,
  NextStepResponse,
  AssistantToolResult,
  ToolCallRecord
} from './request-processor';

export interface PlanExecutorConfig {
  stepLimit: number;
  totalIterationLimit: number;
  stepIterationLimit: number;
}

export class PlanExecutorV1 {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private toolSelector: ToolSelector;
  private requestProcessor: RequestProcessor;
  private mcpManager: MCPManager;
  private promptManager: PromptManager;
  private config: PlanExecutorConfig;

  constructor(
    ollamaClient: OllamaClient,
    toolSelector: ToolSelector,
    requestProcessor: RequestProcessor,
    mcpManager: MCPManager,
    promptManager: PromptManager,
    config: PlanExecutorConfig,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.toolSelector = toolSelector;
    this.requestProcessor = requestProcessor;
    this.mcpManager = mcpManager;
    this.promptManager = promptManager;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Determines if the response contains a plan
   */
  isPlanResponse(response: string): boolean {
    this.logger.debug('PLAN DETECTION ATTEMPT', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...'
    });

    try {
      const parsed = JSON.parse(response.trim());
      const isPlan = parsed && 
             typeof parsed.main_objective === 'string' && 
             Array.isArray(parsed.later_steps) &&
             (parsed.next_step === undefined || 
              (typeof parsed.next_step === 'object' && 
               parsed.next_step.tool && 
               parsed.next_step.prompt));

      this.logger.debug('PLAN DETECTION (DIRECT JSON)', { isPlan });
      return isPlan;
    } catch (parseError) {
      // Try to find plan structure in text
      const jsonMatch = response.match(/\{[\s\S]*"main_objective"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return parsed && 
                 typeof parsed.main_objective === 'string' && 
                 Array.isArray(parsed.later_steps);
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /**
   * Extracts plan from response
   */
  extractPlanFromResponse(response: string): PlanResponse | null {
    try {
      const parsed = JSON.parse(response.trim());
      if (this.isPlanResponse(response)) {
        return parsed as PlanResponse;
      }
    } catch {
      // Try to extract JSON from mixed content
      const jsonMatch = response.match(/\{[\s\S]*"main_objective"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && 
              typeof parsed.main_objective === 'string' && 
              Array.isArray(parsed.later_steps)) {
            return parsed as PlanResponse;
          }
        } catch {
          return null;
        }
      }
    }
    return null;
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
    const streamContext = this.requestProcessor.streamPlanResponse(res, initialPlan);
    
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
          this.requestProcessor.streamFinalConclusion(res, response, streamContext);
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
          this.requestProcessor.streamFinalConclusion(res, errorMessage, streamContext);
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

        const actualArgs = toolArgs && typeof toolArgs === 'object' && 'args' in toolArgs ? toolArgs.args : toolArgs;

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
      args: JSON.stringify({}),
      results: toolResult
    };

    executionState.currentStepToolCalls.push({
      prompt: executionState.currentStep!.prompt,
      tool: executionState.currentStep!.tool,
      args: JSON.stringify({})
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
    const systemPrompt = this.promptManager.getTemplateString('systemMessages.customSystemPrompt') || '';

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
    const completedStepsText = this.requestProcessor.formatCompletedStepsWithTemplates(executionState.completedSteps);
    
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
    const completedStepsText = this.requestProcessor.formatCompletedStepsWithTemplates(executionState.completedSteps);
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
    const completedStepsText = this.requestProcessor.formatCompletedStepsWithTemplates(executionState.completedSteps);
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
    
    const previousToolTemplate = this.promptManager.getTemplateString('responseGeneration.previousTool') || '';
    const previousToolCalls = executionState.currentStepToolCalls.slice(0, -1);
    const previousToolList = previousToolCalls.map(toolCall => {
      const toolVariables: Record<string, string> = {
        prompt: toolCall.prompt,
        tool: toolCall.tool,
        args: toolCall.args
      };
      return this.requestProcessor.replaceTemplateVariables(previousToolTemplate, toolVariables);
    }).join('\n');
    
    const currentStepTemplate = this.promptManager.getTemplateString('responseGeneration.currentStep') || '';
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
    const iterationResponse = this.requestProcessor.parseIterationResponse(response);
    
    if (iterationResponse === null) {
      // Malformed response
      this.requestProcessor.streamFinalConclusion(res, 'Plan execution ended due to malformed response.', streamContext);
      return 'break';
    }
    
    if (typeof iterationResponse === 'string') {
      // Final conclusion reached
      this.requestProcessor.streamFinalConclusion(res, iterationResponse, streamContext);
      return 'break';
    }
    
    if ('completed' in iterationResponse.current_step) {
      // Step completed
      const stepCompleteResponse = iterationResponse as CurrentStepCompleteResponse;
      
      if (!stepCompleteResponse.next_step) {
        this.requestProcessor.streamFinalConclusion(res, stepCompleteResponse.current_step.notes_to_future_self, streamContext);
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
      
      this.requestProcessor.streamStepCompletion(
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
      
      this.requestProcessor.streamStepCompletion(
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
    this.requestProcessor.streamStepCompletion(
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
    
    this.requestProcessor.streamFinalConclusion(res, finalResponse, streamContext);
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
    const systemPrompt = this.promptManager.getTemplateString('systemMessages.customSystemPrompt') || '';
    
    // Build error conclusion prompt
    const completedStepsText = this.requestProcessor.formatCompletedStepsWithTemplates(executionState.completedSteps);
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
    this.requestProcessor.streamFinalConclusion(res, response, { 
      id: 'emergency-conclusion', 
      created: Date.now(), 
      responseModel: 'emergency' 
    });
  }
}