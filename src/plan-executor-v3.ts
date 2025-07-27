import winston from 'winston';
import { OllamaClient } from './ollama-client';
import { MCPManager, OpenAITool } from './mcp-manager';
import { PlanExecutor } from './plan-executor';
import { RequestProcessor } from './request-processor';
import { PromptManager } from './prompt-manager';
import { SearchSnippetProcessor } from './search-snippet-processor';

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
  private searchSnippetProcessor: SearchSnippetProcessor;

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
    this.searchSnippetProcessor = new SearchSnippetProcessor(mcpManager, logger);
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

    this.logger.info('Plan Executor V3 starting keyword-based processing', {
      userRequest: userRequest.substring(0, 100) + '...'
    });

    try {
      // Run keyword extraction and intent classification in parallel
      const [keywords, intent] = await Promise.all([
        this.extractKeywords(userRequest),
        this.classifyUserIntent(userRequest)
      ]);
      this.logger.debug('Keywords and intent determined', { keywords, intent });

      // Expand compound keywords by splitting on space and hyphen
      const expandedKeywords = this.expandKeywords(keywords);
      this.logger.debug('Keywords expanded', { originalKeywords: keywords, expandedKeywords });

      // Get configuration for snippet processing
      const v3Config = this.promptManager.getTemplateByPath('v3') as any;
      const linesBefore = v3Config?.linesBefore || 5;
      const linesAfter = v3Config?.linesAfter || 15;

      // Use SearchSnippetProcessor to get formatted snippets
      const contextualResults = await this.searchSnippetProcessor.processKeywordsToSnippets(
        expandedKeywords,
        linesBefore,
        linesAfter
      );

      // Filter snippets by relevance
      const filteredResults = await this.filterSnippetsByRelevance(userRequest, contextualResults);
      this.logger.debug('Snippets filtered', { 
        originalLength: contextualResults.length,
        filteredLength: filteredResults.length 
      });

      // Evaluate and respond with focused information
      await this.evaluateAndRespond(userRequest, filteredResults, res);

    } catch (error) {
      this.logger.error('Error in request processing', { error: error instanceof Error ? error.message : 'Unknown error' });
      this.requestProcessor.sendStreamingResponse(res, `I encountered an error while processing your request: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract search keywords from user request using fast LLM
   */
  private async extractKeywords(userRequest: string): Promise<string[]> {
    const promptConfig = this.promptManager.getTemplateByPath('v3.keywordExtraction');
    if (!promptConfig || !promptConfig.template) {
      this.logger.error('Keyword extraction prompt not found');
      throw new Error('Keyword extraction prompt configuration missing');
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

      // Parse JSON response
      const parsed = JSON.parse(response.trim());
      if (parsed.keywords && Array.isArray(parsed.keywords)) {
        const validKeywords = parsed.keywords.filter((k: any) => typeof k === 'string' && k.length > 2);
        if (validKeywords.length === 0) {
          throw new Error('No valid keywords extracted');
        }
        return validKeywords;
      }
      
      throw new Error('Invalid keyword response format');
    } catch (error) {
      this.logger.error('Keyword extraction failed', { error });
      throw new Error(`Failed to extract keywords: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Classify what the user wants to do
   */
  private async classifyUserIntent(userRequest: string): Promise<UserIntent> {
    const promptConfig = this.promptManager.getTemplateByPath('v3.intentClassification');
    if (!promptConfig) {
      this.logger.error('Intent classification prompt not found');
      return 'UNDERSTAND';
    }

    if (!promptConfig.template) {
      this.logger.error('Intent classification template is empty');
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
      this.logger.warn('Intent classification failed, using default', { error });
      return 'UNDERSTAND';
    }
  }

  private expandKeywords(keywords: string[]): string[] {
    const expandedKeywords: string[] = [];
    for (const keyword of keywords) {
      const parts = keyword.split(/[\s-]+/).filter(part => part.length > 2);
      expandedKeywords.push(...parts);
    }
    return [...new Set(expandedKeywords)];
  }

  /**
   * Filter snippets by relevance to the user question using fast LLM
   */
  private async filterSnippetsByRelevance(userRequest: string, contextualResults: string): Promise<string> {
    const promptConfig = this.promptManager.getTemplateByPath('v3.snippetFiltering');
    if (!promptConfig || !promptConfig.template) {
      this.logger.warn('Snippet filtering prompt not found, returning all results');
      return contextualResults;
    }

    // Split contextual results into individual snippets
    const snippetSections = contextualResults.split(/^=== .* ===$/m).filter(section => section.trim());
    
    if (snippetSections.length <= 5) {
      // If we have 5 or fewer snippets, no need to filter
      this.logger.debug('5 or fewer snippets found, skipping filtering');
      return contextualResults;
    }

    // Create numbered snippets without line numbers for filtering
    const numberedSnippets = snippetSections.map((section, index) => {
      const lines = section.trim().split('\n');
      // Remove line number formatting for cleaner presentation
      const cleanLines = lines.map(line => {
        // Remove line number arrows and padding
        return line.replace(/^\s*\d+→\s*/, '').replace(/^\s+/, '  ');
      });
      return `${index + 1}. ${cleanLines.join('\n')}`;
    }).join('\n\n');

    const prompt = this.requestProcessor.replaceTemplateVariables(promptConfig.template, {
      userRequest: userRequest,
      snippets: numberedSnippets
    });

    try {
      const response = await this.ollamaClient.sendToOllama(
        prompt,
        promptConfig.temperature!,
        promptConfig.maxTokens!,
        promptConfig.useFastModel!
      );

      // Parse the JSON response to get selected snippet numbers
      const selectedNumbers = JSON.parse(response.trim());
      if (!Array.isArray(selectedNumbers) || selectedNumbers.length === 0) {
        this.logger.warn('Invalid filtering response, returning all results');
        return contextualResults;
      }

      // Map selected numbers back to original sections
      const originalSections = contextualResults.split(/(?=^=== .* ===)/m).filter(section => section.trim());
      const filteredSections = selectedNumbers
        .map(num => originalSections[num - 1])
        .filter(section => section);

      const filteredResult = filteredSections.join('\n');
      
      // Save filtered snippets to debug file
      try {
        const fs = require('fs');
        const path = require('path');
        const tmpPath = path.join(__dirname, '..', '.tmp', 'filtered-snippets.txt');
        fs.writeFileSync(tmpPath, filteredResult, 'utf-8');
        this.logger.debug('Saved filtered snippets to debug file', { path: tmpPath });
      } catch (error) {
        this.logger.warn('Failed to save filtered snippets debug file', { error });
      }
      
      this.logger.debug('Snippet filtering completed', {
        originalSnippets: snippetSections.length,
        selectedNumbers,
        filteredSnippets: filteredSections.length
      });

      return filteredResult || contextualResults; // Fallback if filtering fails
    } catch (error) {
      this.logger.warn('Snippet filtering failed, returning all results', { error });
      return contextualResults;
    }
  }

  /**
   * Evaluate if contextual results answer the question and respond accordingly
   */
  private async evaluateAndRespond(userRequest: string, contextualResults: string, res: any): Promise<void> {
    const promptConfig = this.promptManager.getTemplateByPath('v3.evaluateAndRespond');
    if (!promptConfig || !promptConfig.template) {
      this.logger.error('Evaluate and respond prompt not found or empty');
      this.sendFallbackResponse(contextualResults, res);
      return;
    }

    // If no contextual results found, indicate that
    if (!contextualResults.trim()) {
      this.sendNeedMoreInfoResponse('No relevant information found', 'No matches found for the search keywords', res);
      return;
    }

    const prompt = this.requestProcessor.replaceTemplateVariables(promptConfig.template, {
      userRequest: userRequest,
      toolResult: contextualResults.substring(0, 4000) // Allow more context than before
    });

    try {
      const response = await this.ollamaClient.sendToOllama(
        prompt,
        promptConfig.temperature!,
        promptConfig.maxTokens!,
        promptConfig.useFastModel!
      );

      if (response.trim().startsWith('NEED_MORE_INFO')) {
        const explanation = response.replace('NEED_MORE_INFO', '').trim();
        this.sendNeedMoreInfoResponse(contextualResults, explanation, res);
      } else {
        this.requestProcessor.sendStreamingResponse(res, response);
      }
    } catch (error) {
      this.logger.error('Evaluation failed', { error });
      this.sendFallbackResponse(contextualResults, res);
    }
  }

  /**
   * Send fallback response when evaluation fails
   */
  private sendFallbackResponse(toolResult: string, res: any): void {
    const template = this.promptManager.getTemplateByPath('v3.fallbackResponse');
    if (template?.template) {
      const response = this.requestProcessor.replaceTemplateVariables(template.template, {
        toolResult: toolResult.substring(0, 1000)
      });
      this.requestProcessor.sendStreamingResponse(res, response);
    } else {
      this.requestProcessor.sendStreamingResponse(res, toolResult.substring(0, 1000));
    }
  }

  /**
   * Send response when more information is needed
   */
  private sendNeedMoreInfoResponse(toolResult: string, explanation: string, res: any): void {
    const template = this.promptManager.getTemplateByPath('v3.needMoreInfoResponse');
    if (template?.template) {
      const response = this.requestProcessor.replaceTemplateVariables(template.template, {
        partialResult: toolResult.substring(0, 500) + (toolResult.length > 500 ? '...' : ''),
        explanation: explanation
      });
      this.requestProcessor.sendStreamingResponse(res, response);
    } else {
      this.sendFallbackResponse(toolResult, res);
    }
  }

}