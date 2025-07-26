import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { PromptManager } from './prompt-manager';
import { RequestProcessor } from './request-processor';
import { PlanExecutor } from './plan-executor';
import { OpenAITool } from './mcp-manager';

export interface ParallelTasksResponse {
  initial_tasks: string[];
}

export interface PlanExecutorV2Config {
  // Config can be empty for now, or add specific settings later
}

export class PlanExecutorV2 implements PlanExecutor {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private requestProcessor: RequestProcessor;
  private promptManager: PromptManager;
  private config: PlanExecutorV2Config;

  constructor(
    ollamaClient: OllamaClient,
    requestProcessor: RequestProcessor,
    promptManager: PromptManager,
    config: PlanExecutorV2Config,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.requestProcessor = requestProcessor;
    this.promptManager = promptManager;
    this.config = config;
    this.logger = logger;
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
    await this.executePlan(
      messages,
      res,
      projectFileStructureGetter,
      temperature,
      maxTokens
    );
  }

  /**
   * Execute plan flow: parallelTasks -> simple conclusion
   */
  async executePlan(
    originalMessages: any[],
    res: any,
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    temperature: number,
    maxTokens: number
  ): Promise<void> {
    this.logger.info('Starting plan execution flow');

    try {
      // Get user prompt
      const userMessage = originalMessages.find(msg => msg.role === 'user');
      const userPrompt = userMessage ? userMessage.content : 'No user prompt available';
      
      // Get system prompt and project structure
      const systemPrompt = this.promptManager.getTemplateString('systemMessages.customSystemPrompt')!;
      const projectFileStructure = await projectFileStructureGetter(true);

      // Step 1: Generate parallel tasks
      const tasks = await this.generateParallelTasks(userPrompt, systemPrompt, projectFileStructure, temperature, maxTokens);
      
      // Step 2: Stream the tasks response as conclusion
      this.streamTasksConclusion(res, tasks, userPrompt);

    } catch (error) {
      this.logger.error('Error in plan execution:', error);
      const errorMessage = `Plan execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      
      // Stream error as final conclusion
      const streamContext = { 
        id: 'plan-error', 
        created: Date.now(), 
        responseModel: 'error' 
      };
      this.streamFinalConclusion(res, errorMessage, streamContext);
    }
  }

  /**
   * Generate parallel tasks using the parallelTasks template
   */
  private async generateParallelTasks(
    userPrompt: string,
    systemPrompt: string,
    projectFileStructure: string,
    temperature: number,
    maxTokens: number
  ): Promise<ParallelTasksResponse> {
    this.logger.info('Generating parallel tasks');

    // Build prompt using parallelTasks template
    const templateVariables: Record<string, string> = {
      systemPrompt,
      projectFileStructure,
      userPrompt
    };

    const promptTemplate = this.promptManager.getTemplateString('responseGeneration.parallelTasks');
    if (!promptTemplate) {
      throw new Error('parallelTasks template not found in prompt configuration');
    }

    const prompt = this.requestProcessor.replaceTemplateVariables(promptTemplate, templateVariables);

    this.logger.debug('parallelTasks prompt built', {
      promptLength: prompt.length,
      userPrompt: userPrompt.substring(0, 100) + '...'
    });

    // Get response from model
    const response = await this.ollamaClient.sendToOllama(prompt, temperature, maxTokens);
    
    this.logger.debug('parallelTasks response received', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...'
    });

    // Parse the JSON response
    try {
      const cleanResponse = response.trim().replace(/```json|```/g, '').trim();
      const parsedResponse = JSON.parse(cleanResponse) as ParallelTasksResponse;
      
      if (!parsedResponse.initial_tasks || !Array.isArray(parsedResponse.initial_tasks)) {
        throw new Error('Invalid parallelTasks response: missing or invalid initial_tasks array');
      }

      this.logger.info('parallel tasks generated successfully', {
        taskCount: parsedResponse.initial_tasks.length,
        tasks: parsedResponse.initial_tasks
      });

      return parsedResponse;
    } catch (parseError) {
      this.logger.error('Failed to parse parallelTasks response', {
        response: response,
        error: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      });
      throw new Error(`Failed to parse parallelTasks response: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`);
    }
  }

  /**
   * Stream the tasks as a conclusion response
   */
  private streamTasksConclusion(res: any, tasks: ParallelTasksResponse, userPrompt: string): void {
    this.logger.info('Streaming tasks conclusion');

    // Format the tasks into a readable conclusion
    const tasksList = tasks.initial_tasks
      .map((task, index) => `${index + 1}. ${task}`)
      .join('\n');

    const conclusion = `Based on your request: "${userPrompt}"

I've identified the following initial task objectives that should be performed to help resolve your request:

${tasksList}

This is a plan execution flow that focuses on parallel task identification. Each of these tasks could be executed independently to gather the necessary information and complete your request.`;

    // Create stream context for the conclusion
    const streamContext = { 
      id: 'plan-conclusion', 
      created: Date.now(), 
      responseModel: 'parallel-tasks' 
    };

    // Stream the conclusion
    this.streamFinalConclusion(res, conclusion, streamContext);
  }

  /**
   * Stream final conclusion using generic streaming utilities
   */
  private streamFinalConclusion(res: any, conclusion: string, streamContext?: { id: string, created: number, responseModel: string }): void {
    const id = streamContext?.id || `chatcmpl-${Date.now()}`;
    const created = streamContext?.created || Math.floor(Date.now() / 1000);
    const responseModel = streamContext?.responseModel || 'default';

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });

    const header = `\nPlan Complete\n${'='.repeat(13)}\n\n`;
    this.requestProcessor.streamChunk(res, header, id, created, responseModel);
    this.requestProcessor.streamChunk(res, conclusion, id, created, responseModel);
    this.requestProcessor.finishStream(res, id, created, responseModel, conclusion.length + 50);
  }
}