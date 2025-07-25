import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { ToolSelector } from './tool-selector';
import { OpenAITool } from './mcp-manager';

export interface FIMRequest {
  prefix: string;
  suffix: string;
  isFIM: boolean;
}

// Assistant Tool Result Type - for tracking tool execution with context
export interface AssistantToolResult {
  tool: string;
  prompt: string;
  args: string; // JSON stringified arguments
  results: string;
}

// Current Step Iteration Response Type - when model continues working on current step
export interface CurrentStepIterationResponse {
  current_step: {
    notes_to_future_self: string;
    tool: string;
    prompt: string;
  };
  later_steps?: string[];
}

// Current Step Complete Response Type - when model completes current step
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

// Next Step Response Type - for defining new steps (used in initial planning and step transitions)
export interface NextStepResponse {
  objective: string;
  tool: string;
  prompt: string;
}

// Completed Step Request Type - for tracking completed steps in prompts
export interface CompletedStepRequest {
  objective: string;
  success: boolean;
  conclusion: string;
}

// Current Step Request Type - for providing current step context in prompts
export interface CurrentStepRequest {
  objective: string;
  completed: boolean;
  notes: string; // notes_to_future_self
  assistant: AssistantToolResult;
}

// Legacy interfaces - to be phased out
export interface PlanStep {
  purpose: string;
  tool: string;
  prompt: string;
}

export interface PlanResponse {
  main_objective: string;
  conclusion_from_assistant_data?: string;
  assistant_data_was_helpful?: boolean;
  next_step?: NextStepResponse;
  later_steps: string[];
}

export interface PlanExecutionState {
  objective: string;
  completedSteps: CompletedStepRequest[];
  currentStep?: NextStepResponse;
  currentStepNotes?: string; // notes_to_future_self from previous iterations
  currentStepAssistant?: AssistantToolResult; // current tool result for current step
  laterSteps: string[];
  stepResults: string[];
}

export interface ResponseGenerationConfig {
  planDecision?: { template?: string }; // renamed from toolResultsNonStreaming
  planIteration?: { template?: string };
  finalIteration?: { template?: string };
}

export interface SystemMessageConfig {
  customSystemPrompt?: { template?: string; enabled?: boolean };
}

export class RequestProcessor {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private responseConfig: ResponseGenerationConfig;
  private systemConfig: SystemMessageConfig;
  private toolSelector: ToolSelector;

  constructor(
    ollamaClient: OllamaClient,
    responseConfig: ResponseGenerationConfig,
    systemConfig: SystemMessageConfig,
    toolSelector: ToolSelector,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.responseConfig = responseConfig;
    this.systemConfig = systemConfig;
    this.toolSelector = toolSelector;
    this.logger = logger;
  }

  updateConfig(responseConfig: ResponseGenerationConfig, systemConfig: SystemMessageConfig): void {
    this.responseConfig = responseConfig;
    this.systemConfig = systemConfig;
    this.logger.debug('RequestProcessor configuration updated');
  }

  /**
   * Generic method to replace variables in a template string
   * @param template The template string containing variables like {variableName}
   * @param variables Object containing variable names and their replacement values
   * @returns The template with all variables replaced
   */
  replaceTemplateVariables(template: string, variables: Record<string, string>): string {
    let result = template;
    
    // Replace each variable in the template
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      // Use global replace to handle multiple occurrences
      result = result.split(placeholder).join(value || '');
    }
    
    return result;
  }

  convertMessagesToPrompt(messages: any[], systemContext?: string): string {
    // Check if we should override the system prompt
    const customSystem = this.systemConfig.customSystemPrompt;
    let modifiedMessages = messages;
    
    if (customSystem?.enabled && customSystem.template) {
      // Replace system message with custom one
      modifiedMessages = messages.map(msg => {
        if (msg.role === 'system') {
          this.logger.info('Overriding Continue system prompt with custom prompt from prompts.json');
          return { ...msg, content: customSystem.template };
        }
        return msg;
      });
    }
    
    // Convert messages to prompt, handling both old and new assistant message formats
    const promptParts = modifiedMessages.map((msg, index) => {
      let messageText: string;
      
      if (msg.role === 'assistant' && typeof msg.content === 'object' && msg.content.tool) {
        // New Assistant Tool Result Type format
        const assistantResult = msg.content as AssistantToolResult;
        messageText = `assistant: Used tool "${assistantResult.tool}" with prompt "${assistantResult.prompt}" and arguments ${assistantResult.args}. Result: ${assistantResult.results}`;
      } else {
        // Standard message format
        messageText = `${msg.role}: ${msg.content}`;
      }
      
      // If this is the system message and we have system context, add it after
      if (msg.role === 'system' && systemContext) {
        messageText += '\n\n' + systemContext;
      }
      
      return messageText;
    });
    
    const prompt = promptParts.join('\n\n');
    
    // Debug logging: Prompt conversion
    this.logger.debug('PROMPT CONVERSION', {
      messageCount: modifiedMessages.length,
      messages: modifiedMessages,
      finalPrompt: prompt.substring(0, 500) + (prompt.length > 500 ? '...' : ''),
      promptLength: prompt.length,
      hasCustomSystem: customSystem?.enabled || false
    });
    
    return prompt;
  }

  parseFIMRequest(prompt: string): FIMRequest {
    // Check if this is a FIM (Fill-In-Middle) request
    if (!prompt.includes('<fim_prefix>') || !prompt.includes('<fim_suffix>')) {
      return { prefix: prompt, suffix: '', isFIM: false };
    }

    // Find the last occurrence of the FIM pattern to handle embedded content correctly
    const lastFimSuffixIndex = prompt.lastIndexOf('<fim_suffix>');
    const lastFimMiddleIndex = prompt.lastIndexOf('<fim_middle>');

    if (lastFimSuffixIndex === -1 || lastFimMiddleIndex === -1) {
      return { prefix: prompt, suffix: '', isFIM: false };
    }

    // Extract prefix (everything between <fim_prefix> and the last <fim_suffix>)
    const prefixStart = prompt.indexOf('<fim_prefix>') + '<fim_prefix>'.length;
    const prefix = prompt.substring(prefixStart, lastFimSuffixIndex);

    // Extract suffix (everything between the last <fim_suffix> and <fim_middle>)
    const suffixStart = lastFimSuffixIndex + '<fim_suffix>'.length;
    const suffix = prompt.substring(suffixStart, lastFimMiddleIndex);

    return { prefix, suffix, isFIM: true };
  }

  sendStreamingResponse(res: any, content: string, model?: string): void {
    this.logger.info('Sending streaming response to Continue');

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

    this.logger.debug('Streaming response details', {
      contentLength: content.length,
      model: responseModel,
      responseId: id,
    });

    // Split response into chunks and send as streaming
    const words = content.split(' ');

    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + (i < words.length - 1 ? ' ' : '');

      const streamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: { content: chunk },
            finish_reason: null,
          },
        ],
      };

      // Debug logging: Streaming response chunks to Continue
      this.logger.debug('STREAMING CHUNK TO CONTINUE', {
        chunkIndex: i,
        totalChunks: words.length,
        chunk: chunk,
        streamChunk: streamChunk
      });

      const chunkData = `data: ${JSON.stringify(streamChunk)}\n\n`;
      res.write(chunkData);
    }

    // Send final chunk with finish_reason
    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: this.estimateTokens(content),
        completion_tokens: words.length,
        total_tokens: this.estimateTokens(content) + words.length,
      },
    };

    const finalChunkData = `data: ${JSON.stringify(finalChunk)}\n\n`;
    const doneData = 'data: [DONE]\n\n';

    this.logger.debug('Streaming response completed', { totalWords: words.length });

    res.write(finalChunkData);
    res.write(doneData);
    res.end();
  }

  async generateResponseWithToolResults(
    messages: any[],
    temperature: number,
    maxTokens: number,
    tools?: OpenAITool[],
    systemContext?: string
  ): Promise<string> {
    // Get the plan decision template
    const planDecisionTemplate = this.responseConfig.planDecision!.template!;
    
    // Extract userPrompt from messages
    const userMessage = messages.find(msg => msg.role === 'user');
    const userPrompt = userMessage ? userMessage.content : 'No user prompt available';
    
    // Create assistantContext from assistant tool usage
    const assistantMessages = messages.filter(msg => msg.role === 'assistant');
    const assistantContext = assistantMessages.map(msg => {
      if (typeof msg.content === 'object' && msg.content.tool) {
        const assistantResult = msg.content as AssistantToolResult;
        return `Used tool "${assistantResult.tool}" with prompt "${assistantResult.prompt}" and arguments ${assistantResult.args}. Result: ${assistantResult.results}`;
      }
      return msg.content;
    }).join('\n\n');
    
    // Prepare template variables
    const templateVariables: Record<string, string> = {
      systemPrompt: this.systemConfig?.customSystemPrompt?.template || '',
      systemContext: systemContext || '',
      userPrompt: userPrompt,
      assistantContext: assistantContext
    };
    
    // Add tools if provided
    if (tools && tools.length > 0) {
      templateVariables.toolNamesAndHints = this.toolSelector.formatToolsWithUsageHints(tools);
    } else {
      // Remove the tools section from template if no tools provided
      templateVariables.toolNamesAndHints = '';
    }
    
    // Replace all template variables
    let prompt = this.replaceTemplateVariables(planDecisionTemplate, templateVariables);
    
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
      hasSystemContext: !!systemContext
    });

    return await this.ollamaClient.sendToOllama(prompt, temperature, maxTokens);
  }


  private estimateTokens(text: string): number {
    // Simple token estimation (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }

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
             Array.isArray(parsed.later_steps) &&
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
                 Array.isArray(parsed.later_steps);

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

  // New methods for improved plan iteration handling
  parseIterationResponse(response: string): CurrentStepIterationResponse | CurrentStepCompleteResponse | string | null {
    this.logger.debug('ITERATION RESPONSE PARSING ATTEMPT', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...'
    });

    try {
      const parsed = JSON.parse(response.trim());
      
      // Check for current step iteration (Option 1)
      if (parsed.current_step && parsed.current_step.tool && parsed.current_step.prompt) {
        const iterationResponse: CurrentStepIterationResponse = {
          current_step: {
            notes_to_future_self: parsed.current_step.notes_to_future_self || '',
            tool: parsed.current_step.tool,
            prompt: parsed.current_step.prompt
          },
          later_steps: parsed.later_steps
        };
        
        this.logger.debug('ITERATION RESPONSE: Current step iteration', {
          response: iterationResponse
        });
        
        return iterationResponse;
      }
      
      // Check for step completion (Option 2)
      if (parsed.current_step && parsed.current_step.completed === true) {
        const completeResponse: CurrentStepCompleteResponse = {
          current_step: {
            completed: true,
            success: parsed.current_step.success || false,
            notes_to_future_self: parsed.current_step.notes_to_future_self || ''
          },
          next_step: parsed.next_step ? {
            objective: parsed.next_step.objective,
            tool: parsed.next_step.tool,
            prompt: parsed.next_step.prompt
          } : undefined,
          later_steps: parsed.later_steps
        };
        
        this.logger.debug('ITERATION RESPONSE: Step completion', {
          response: completeResponse,
          hasNextStep: !!parsed.next_step
        });
        
        return completeResponse;
      }
      
      // If neither pattern matches, treat as malformed
      this.logger.debug('ITERATION RESPONSE: Malformed JSON structure', {
        parsedStructure: parsed
      });
      return null;
      
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
          
          // Check for current step iteration (Option 1)
          if (parsed.current_step && parsed.current_step.tool && parsed.current_step.prompt) {
            const iterationResponse: CurrentStepIterationResponse = {
              current_step: {
                notes_to_future_self: parsed.current_step.notes_to_future_self || '',
                tool: parsed.current_step.tool,
                prompt: parsed.current_step.prompt
              },
              later_steps: parsed.later_steps
            };
            
            this.logger.debug('ITERATION RESPONSE: Current step iteration (from markdown)', {
              response: iterationResponse
            });
            
            return iterationResponse;
          }
          
          // Check for step completion (Option 2)
          if (parsed.current_step && parsed.current_step.completed === true) {
            const completeResponse: CurrentStepCompleteResponse = {
              current_step: {
                completed: true,
                success: parsed.current_step.success || false,
                notes_to_future_self: parsed.current_step.notes_to_future_self || ''
              },
              next_step: parsed.next_step ? {
                objective: parsed.next_step.objective,
                tool: parsed.next_step.tool,
                prompt: parsed.next_step.prompt
              } : undefined,
              later_steps: parsed.later_steps
            };
            
            this.logger.debug('ITERATION RESPONSE: Step completion (from markdown)', {
              response: completeResponse,
              hasNextStep: !!parsed.next_step
            });
            
            return completeResponse;
          }
          
          // If neither pattern matches, treat as malformed
          this.logger.debug('ITERATION RESPONSE: Malformed JSON structure (from markdown)', {
            parsedStructure: parsed
          });
          return null;
          
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
              Array.isArray(parsed.later_steps)) {
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
    this.streamChunk(res, planIntro, id, created, responseModel);

    // Stream plan steps
    if (plan.later_steps && plan.later_steps.length > 0) {
      plan.later_steps.forEach((step, index) => {
        const stepText = `- ${step}\n`;
        this.logger.debug('PLAN STREAMING STEP', {
          stepIndex: index,
          stepContent: stepText,
          stepLength: stepText.length
        });
        this.streamChunk(res, stepText, id, created, responseModel);
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
      this.streamChunk(res, stepHeader, id, created, responseModel);
    }

    this.logger.debug('PLAN STREAMING COMPLETION', {
      totalContentEstimate: planIntro.length + 100,
      note: 'Stream kept open for plan execution'
    });
    // Don't finish the stream - keep it open for plan execution
    // Return stream context for continued streaming
    return { id, created, responseModel };
  }

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
      this.streamChunk(res, completionText, id, created, responseModel);
    }

    // Stream next step if present
    if (nextStep) {
      const stepHeader = `${nextStep.objective}\n${'-'.repeat(nextStep.objective.length)}\n`;
      this.logger.debug('STEP COMPLETION STREAMING NEXT STEP', {
        stepHeader: stepHeader,
        headerLength: stepHeader.length,
        nextStepDetails: nextStep
      });
      this.streamChunk(res, stepHeader, id, created, responseModel);
    }

    this.logger.debug('STEP COMPLETION STREAMING END');
  }

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
    this.streamChunk(res, header, id, created, responseModel);

    this.logger.debug('FINAL CONCLUSION STREAMING CONTENT', {
      conclusion: conclusion,
      conclusionLength: conclusion.length
    });
    this.streamChunk(res, conclusion, id, created, responseModel);

    this.logger.debug('FINAL CONCLUSION STREAMING END', {
      totalEstimate: conclusion.length + 50
    });
    this.finishStream(res, id, created, responseModel, conclusion.length + 50);
  }

  private streamChunk(res: any, content: string, id: string, created: number, model: string): void {
    const words = content.split(' ');
    
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
      
      const streamChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: chunk },
            finish_reason: null,
          },
        ],
      };

      const chunkData = `data: ${JSON.stringify(streamChunk)}\n\n`;
      res.write(chunkData);
    }
  }

  private finishStream(res: any, id: string, created: number, model: string, tokenEstimate: number): void {
    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: tokenEstimate,
        completion_tokens: Math.floor(tokenEstimate / 2),
        total_tokens: Math.floor(tokenEstimate * 1.5),
      },
    };

    const finalChunkData = `data: ${JSON.stringify(finalChunk)}\n\n`;
    const doneData = 'data: [DONE]\n\n';

    res.write(finalChunkData);
    res.write(doneData);
    res.end();
  }
}
