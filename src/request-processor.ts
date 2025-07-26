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





export interface SystemMessageConfig {
  customSystemPrompt?: { template?: string; enabled?: boolean };
}

export class RequestProcessor {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private systemConfig: SystemMessageConfig;
  private toolSelector: ToolSelector;

  constructor(
    ollamaClient: OllamaClient,
    systemConfig: SystemMessageConfig,
    toolSelector: ToolSelector,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.systemConfig = systemConfig;
    this.toolSelector = toolSelector;
    this.logger = logger;
  }

  updateConfig(systemConfig: SystemMessageConfig): void {
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

  /**
   * Format tool results as block quotes by prepending '>' to each line
   * @param results The tool results string
   * @returns The formatted results with block quote formatting
   */
  formatToolResultsAsBlockQuote(results: string): string {
    return results.split('\n').map(line => `> ${line}`).join('\n');
  }


  convertMessagesToPrompt(messages: any[], projectFileStructure?: string): string {
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
        const formattedResults = this.formatToolResultsAsBlockQuote(assistantResult.results);
        messageText = `assistant: Used tool "${assistantResult.tool}" with prompt "${assistantResult.prompt}" and arguments ${assistantResult.args}. Result:\n${formattedResults}`;
      } else {
        // Standard message format
        messageText = `${msg.role}: ${msg.content}`;
      }
      
      // If this is the system message and we have project file structure, add it after
      if (msg.role === 'system' && projectFileStructure) {
        messageText += '\n\n' + projectFileStructure;
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



  private estimateTokens(text: string): number {
    // Simple token estimation (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }





  streamChunk(res: any, content: string, id: string, created: number, model: string): void {
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

  finishStream(res: any, id: string, created: number, model: string, tokenEstimate: number): void {
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
