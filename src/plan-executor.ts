import { OpenAITool } from './mcp-manager';

/**
 * Generic plan executor interface for routing requests
 */
export interface PlanExecutor {
  /**
   * Handle a request and determine if it requires plan execution
   * @param messages The conversation messages
   * @param res The response object for streaming
   * @param temperature Temperature for model generation
   * @param maxTokens Max tokens for model generation
   * @param tools Available MCP tools
   * @param projectFileStructureGetter Function to get project structure
   * @param defaultTemperature Default temperature fallback
   * @param defaultMaxTokens Default max tokens fallback
   * @returns Promise that resolves when request is handled
   */
  handleRequest(
    messages: any[],
    res: any,
    temperature: number,
    maxTokens: number,
    tools: OpenAITool[],
    projectFileStructureGetter: (forceRefresh?: boolean) => Promise<string>,
    defaultTemperature?: number,
    defaultMaxTokens?: number
  ): Promise<void>;
}