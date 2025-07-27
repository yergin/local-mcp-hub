import winston from 'winston';
import { MCPManager } from './mcp-manager';

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

export class SearchSnippetProcessor {
  private logger: winston.Logger;
  private mcpManager: MCPManager;

  constructor(mcpManager: MCPManager, logger: winston.Logger) {
    this.mcpManager = mcpManager;
    this.logger = logger;
  }

  /**
   * Main entry point: takes keywords and returns formatted code snippets
   */
  async processKeywordsToSnippets(
    keywords: string[],
    linesBefore: number,
    linesAfter: number
  ): Promise<string> {
    // Search for keywords across all files
    const searchResults = await this.searchForKeywords(keywords);
    this.logger.debug('Search completed', { 
      totalMatches: searchResults.length,
      files: [...new Set(searchResults.map(r => r.file))]
    });

    // Merge close results and get context
    const mergedResults = this.mergeCloseResults(searchResults, linesBefore, linesAfter);
    this.logger.debug('Results merged', { 
      mergedCount: mergedResults.length 
    });

    // Read context around matches
    const contextualResults = await this.readContextAroundMatches(mergedResults, keywords);
    this.logger.debug('Context gathered', { 
      contextLength: contextualResults.length 
    });

    return contextualResults;
  }

  /**
   * Search for keywords across all files in workspace
   */
  private async searchForKeywords(keywords: string[]): Promise<SearchMatch[]> {
    const allMatches: SearchMatch[] = [];

    for (const keyword of keywords) {
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
  private mergeCloseResults(searchResults: SearchMatch[], linesBefore: number, linesAfter: number): MergedSearchResult[] {
    const merged: MergedSearchResult[] = [];
    
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
    
    // Take top 20 and reverse order (lowest relevance first for final presentation)
    const top20Results = sortedResults.slice(0, 20);
    const finalResults = [...top20Results].reverse();

    for (const result of finalResults) {
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
}