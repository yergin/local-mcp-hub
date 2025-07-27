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
  matchedKeywords: string[]; // Keywords that matched on this line
}

// Merged search results
export interface MergedSearchResult {
  file: string;
  startLine: number;
  endLine: number;
  contextLines: string[];
  allUniqueKeywords: string[]; // All unique keywords found in this snippet
  maxUniqueKeywordsPerLine: number; // Max unique keywords found on any single line
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
      const { matches: searchResults, expandedKeywords } = await this.searchForKeywords(keywords);
      this.logger.debug('Search completed', { 
        totalMatches: searchResults.length,
        files: [...new Set(searchResults.map(r => r.file))],
        expandedKeywords
      });

      // Merge close results and get context
      const mergedResults = this.mergeCloseResults(searchResults);
      this.logger.debug('Results merged', { 
        mergedCount: mergedResults.length 
      });

      // Read context around matches
      const contextualResults = await this.readContextAroundMatches(mergedResults, expandedKeywords);
      this.logger.debug('Context gathered', { 
        contextLength: contextualResults.length 
      });

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

  /**
   * Search for keywords across all files in workspace
   */
  private async searchForKeywords(keywords: string[]): Promise<{ matches: SearchMatch[], expandedKeywords: string[] }> {
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

    return { matches: allMatches, expandedKeywords: uniqueKeywords };
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
                content: content.trim(),
                matchedKeywords: [keyword]
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
   * Merge search results that are close together
   */
  private mergeCloseResults(searchResults: SearchMatch[]): MergedSearchResult[] {
    const merged: MergedSearchResult[] = [];
    
    // Get merge distance from config
    const v3Config = this.promptManager.getTemplateByPath('v3') as any;
    const linesBefore = v3Config?.linesBefore || 5;
    const linesAfter = v3Config?.linesAfter || 15;
    const mergeDistance = linesBefore + linesAfter + 1;
    
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
          if (match.line - lastLine <= mergeDistance) {
            // Within merge distance, add to current group
            currentGroup.push(match);
          } else {
            // Too far, create new group
            merged.push(this.createMergedResult(file, currentGroup, linesBefore, linesAfter));
            currentGroup = [match];
          }
        }
      }
      
      // Add final group
      if (currentGroup.length > 0) {
        merged.push(this.createMergedResult(file, currentGroup, linesBefore, linesAfter));
      }
    }

    return merged;
  }

  /**
   * Create a merged result from a group of close matches
   */
  private createMergedResult(file: string, matches: SearchMatch[], linesBefore: number, linesAfter: number): MergedSearchResult {
    const lines = matches.map(m => m.line);
    const minLine = Math.min(...lines);
    const maxLine = Math.max(...lines);
    
    // Collect all unique keywords across all matches
    const allUniqueKeywords = [...new Set(matches.flatMap(m => m.matchedKeywords))];
    
    // Calculate max unique keywords per line by grouping matches by line number
    const matchesByLine = new Map<number, SearchMatch[]>();
    for (const match of matches) {
      if (!matchesByLine.has(match.line)) {
        matchesByLine.set(match.line, []);
      }
      matchesByLine.get(match.line)!.push(match);
    }
    
    let maxUniqueKeywordsPerLine = 0;
    for (const [lineNum, lineMatches] of matchesByLine) {
      const uniqueKeywordsOnLine = [...new Set(lineMatches.flatMap(m => m.matchedKeywords))];
      maxUniqueKeywordsPerLine = Math.max(maxUniqueKeywordsPerLine, uniqueKeywordsOnLine.length);
    }
    
    return {
      file,
      startLine: Math.max(1, minLine - linesBefore),
      endLine: maxLine + linesAfter,
      contextLines: [], // Will be filled by readContextAroundMatches
      allUniqueKeywords,
      maxUniqueKeywordsPerLine
    };
  }

  /**
   * Sort merged results by keyword relevance and file depth
   */
  private sortResultsByRelevance(mergedResults: MergedSearchResult[]): MergedSearchResult[] {
    const sortedResults = mergedResults.sort((a, b) => {
      // Calculate file depth (higher depth = more specific/nested)
      const depthA = a.file.split('/').length;
      const depthB = b.file.split('/').length;

      // Scoring: prioritize max unique keywords per line, then total unique keywords in snippet, then file depth
      const scoreA = (a.maxUniqueKeywordsPerLine * 1000) + (a.allUniqueKeywords.length * 100) + depthA;
      const scoreB = (b.maxUniqueKeywordsPerLine * 1000) + (b.allUniqueKeywords.length * 100) + depthB;

      // Sort by score (highest first)
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }

      // If scores are equal, sort by file path for consistent ordering
      return a.file.localeCompare(b.file);
    });

    this.logger.debug('Results sorted by keyword relevance', {
      scores: sortedResults.map(r => ({
        file: r.file,
        maxUniquePerLine: r.maxUniqueKeywordsPerLine,
        totalUniqueKeywords: r.allUniqueKeywords.length,
        depth: r.file.split('/').length,
        score: (r.maxUniqueKeywordsPerLine * 1000) + (r.allUniqueKeywords.length * 100) + r.file.split('/').length
      }))
    });

    return sortedResults;
  }

  /**
   * Read context around each merged search result
   */
  private async readContextAroundMatches(mergedResults: MergedSearchResult[], keywords: string[]): Promise<string> {
    const contextSections: string[] = [];

    // Sort results by relevance: keyword density, unique keywords, then file depth
    const sortedResults = this.sortResultsByRelevance(mergedResults);

    for (const result of sortedResults) {
      try {
        this.logger.debug(`Reading context for ${result.file}:${result.startLine}-${result.endLine}`);
        
        // Read the specific line range from the file
        const fileContent = await this.mcpManager.callMCPTool('read_file', {
          file_path: result.file,
          start_line: result.startLine,
          max_lines: result.endLine - result.startLine + 1
        });

        // Format the context with highlighted keyword lines
        const formattedContent = this.formatContentWithHighlights(fileContent, result.startLine, keywords);
        const section = `=== ${result.file} (lines ${result.startLine}-${result.endLine}) ===\n${formattedContent}\n`;
        contextSections.push(section);
        
      } catch (error) {
        this.logger.warn(`Failed to read context for ${result.file}`, { error });
        contextSections.push(`=== ${result.file} ===\n[Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}]\n`);
      }
    }

    const finalResult = contextSections.join('\n');
    
    // Save to debug file
    try {
      const fs = require('fs');
      const path = require('path');
      const tmpPath = path.join(__dirname, '..', '.tmp', 'search-excerpts.txt');
      fs.writeFileSync(tmpPath, finalResult, 'utf-8');
      this.logger.debug('Saved search excerpts to debug file', { path: tmpPath });
    } catch (error) {
      this.logger.warn('Failed to save search excerpts debug file', { error });
    }

    return finalResult;
  }

  /**
   * Format file content with line numbers, highlighting lines that contain keywords
   */
  private formatContentWithHighlights(content: string, startLine: number, keywords: string[]): string {
    const lines = content.split('\n');
    const formatted: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = startLine + i;
      const line = lines[i];
      
      // Check if this line contains any of the keywords (case-insensitive)
      const containsKeyword = keywords.some(keyword => 
        line.toLowerCase().includes(keyword.toLowerCase())
      );
      
      if (containsKeyword) {
        // Highlight with line number and arrow
        formatted.push(`${lineNumber}→ ${line}`);
      } else {
        // Pad with spaces to match line number width
        const padding = ' '.repeat(lineNumber.toString().length + 1); // +1 for the arrow
        formatted.push(`${padding} ${line}`);
      }
    }
    
    return formatted.join('\n');
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

    // Trim to maximum of 20 snippets (they are already sorted by relevance, so take the top 20)
    const trimmedSections = snippetSections.slice(0, 20);
    
    if (trimmedSections.length < snippetSections.length) {
      this.logger.debug('Trimmed snippets for filtering', {
        original: snippetSections.length,
        trimmed: trimmedSections.length
      });
    }

    // Create numbered snippets without line numbers for filtering (in reverse order)
    const reversedSections = [...trimmedSections].reverse();
    const numberedSnippets = reversedSections.map((section, index) => {
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

      // Map selected numbers back to original sections (accounting for reverse order)
      const originalSections = contextualResults.split(/(?=^=== .* ===)/m).filter(section => section.trim());
      const filteredSections = selectedNumbers
        .map(num => {
          // Reverse the index since we presented them in reverse order
          const reverseIndex = reversedSections.length - num;
          // Find the corresponding section in the original results
          const targetSection = reversedSections[num - 1];
          return originalSections.find(section => section.trim() === targetSection.trim());
        })
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