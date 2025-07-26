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

// Search result with context
export interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

// Merged search results
export interface MergedSearchResult {
  file: string;
  startLine: number;
  endLine: number;
  contextLines: string[];
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

      // Search for keywords across all files
      const searchResults = await this.searchForKeywords(keywords);
      this.logger.debug('Search completed', { 
        totalMatches: searchResults.length,
        files: [...new Set(searchResults.map(r => r.file))]
      });

      // Merge close results and get context
      const mergedResults = this.mergeCloseResults(searchResults);
      this.logger.debug('Results merged', { 
        mergedCount: mergedResults.length 
      });

      // Read context around matches
      const contextualResults = await this.readContextAroundMatches(mergedResults);
      this.logger.debug('Context gathered', { 
        contextLength: contextualResults.length 
      });

      // Evaluate and respond with focused information
      await this.evaluateAndRespond(userRequest, contextualResults, res);

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

  /**
   * Search for keywords across all files in workspace
   */
  private async searchForKeywords(keywords: string[]): Promise<SearchMatch[]> {
    const allMatches: SearchMatch[] = [];

    // Split compound keywords by space and hyphen
    const expandedKeywords: string[] = [];
    for (const keyword of keywords) {
      const parts = keyword.split(/[\s-]+/).filter(part => part.length > 2);
      expandedKeywords.push(...parts);
    }

    // Remove duplicates
    const uniqueKeywords = [...new Set(expandedKeywords)];

    for (const keyword of uniqueKeywords) {
      try {
        this.logger.debug(`Searching for keyword "${keyword}"`);
        
        // Use search_for_pattern to find the keyword
        const result = await this.mcpManager.callMCPTool('search_for_pattern', {
          substring_pattern: keyword,
          path: '.'
        });

        // Parse the search results
        const matches = this.parseSearchResults(result, keyword);
        allMatches.push(...matches);
        
      } catch (error) {
        this.logger.warn(`Search failed for keyword "${keyword}"`, { error });
      }
    }

    return allMatches;
  }

  /**
   * Parse search results from MCP tool response
   */
  private parseSearchResults(searchResult: string, keyword: string): SearchMatch[] {
    const matches: SearchMatch[] = [];
    
    try {
      // Parse JSON response from serena search tool
      const parsed = JSON.parse(searchResult);
      
      // Iterate through files in the response
      for (const [fileName, results] of Object.entries(parsed)) {
        if (Array.isArray(results)) {
          for (const result of results) {
            // Parse line like "  > 154:6. **Response**: content..."
            const lineMatch = result.match(/>\s*(\d+):(.*)/);
            if (lineMatch) {
              const [, lineNum, content] = lineMatch;
              matches.push({
                file: fileName,
                line: parseInt(lineNum),
                content: content.trim()
              });
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to parse search results', { error, keyword, searchResult });
    }

    return matches;
  }

  /**
   * Merge search results that are close together (within 5 lines)
   */
  private mergeCloseResults(searchResults: SearchMatch[]): MergedSearchResult[] {
    const merged: MergedSearchResult[] = [];
    
    // Group by file
    const byFile = new Map<string, SearchMatch[]>();
    for (const match of searchResults) {
      if (!byFile.has(match.file)) {
        byFile.set(match.file, []);
      }
      byFile.get(match.file)!.push(match);
    }

    // Merge close matches within each file
    for (const [file, matches] of byFile) {
      // Sort by line number
      matches.sort((a, b) => a.line - b.line);
      
      let currentGroup: SearchMatch[] = [];
      
      for (const match of matches) {
        if (currentGroup.length === 0) {
          currentGroup = [match];
        } else {
          const lastLine = currentGroup[currentGroup.length - 1].line;
          if (match.line - lastLine <= 5) {
            // Within 5 lines, add to current group
            currentGroup.push(match);
          } else {
            // Too far, create new group
            merged.push(this.createMergedResult(file, currentGroup));
            currentGroup = [match];
          }
        }
      }
      
      // Add final group
      if (currentGroup.length > 0) {
        merged.push(this.createMergedResult(file, currentGroup));
      }
    }

    return merged;
  }

  /**
   * Create a merged result from a group of close matches
   */
  private createMergedResult(file: string, matches: SearchMatch[]): MergedSearchResult {
    const lines = matches.map(m => m.line);
    const minLine = Math.min(...lines);
    const maxLine = Math.max(...lines);
    
    return {
      file,
      startLine: Math.max(1, minLine - 3), // 3 lines of context before
      endLine: maxLine + 3, // 3 lines of context after
      contextLines: [] // Will be filled by readContextAroundMatches
    };
  }

  /**
   * Read context around each merged search result
   */
  private async readContextAroundMatches(mergedResults: MergedSearchResult[]): Promise<string> {
    const contextSections: string[] = [];

    // Sort results by file depth (reverse order - deepest files first, root files last)
    const sortedResults = mergedResults.sort((a, b) => {
      const depthA = a.file.split('/').length;
      const depthB = b.file.split('/').length;
      return depthB - depthA; // Reverse order: deeper files first, root files last
    });

    for (const result of sortedResults) {
      try {
        this.logger.debug(`Reading context for ${result.file}:${result.startLine}-${result.endLine}`);
        
        // Read the specific line range from the file
        const fileContent = await this.mcpManager.callMCPTool('read_file', {
          file_path: result.file,
          start_line: result.startLine,
          max_lines: result.endLine - result.startLine + 1
        });

        // Format the context nicely
        const section = `=== ${result.file} (lines ${result.startLine}-${result.endLine}) ===\n${fileContent}\n`;
        contextSections.push(section);
        
      } catch (error) {
        this.logger.warn(`Failed to read context for ${result.file}`, { error });
        contextSections.push(`=== ${result.file} ===\n[Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}]\n`);
      }
    }

    return contextSections.join('\n');
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