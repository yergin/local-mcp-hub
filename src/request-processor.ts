import winston from 'winston';
import { OllamaClient } from './ollama-client';

export interface FIMRequest {
  prefix: string;
  suffix: string;
  isFIM: boolean;
}

export interface ResponseGenerationConfig {
  toolResultsStreaming?: { template?: string };
  toolResultsNonStreaming?: { template?: string };
}

export class RequestProcessor {
  private logger: winston.Logger;
  private ollamaClient: OllamaClient;
  private responseConfig: ResponseGenerationConfig;

  constructor(
    ollamaClient: OllamaClient,
    responseConfig: ResponseGenerationConfig,
    logger: winston.Logger
  ) {
    this.ollamaClient = ollamaClient;
    this.responseConfig = responseConfig;
    this.logger = logger;
  }

  convertMessagesToPrompt(messages: any[]): string {
    const prompt = messages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
    
    // Debug logging: Prompt conversion
    this.logger.debug('PROMPT CONVERSION', {
      messageCount: messages.length,
      messages: messages,
      finalPrompt: prompt,
      promptLength: prompt.length
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
    maxTokens: number
  ): Promise<string> {
    // Find the tool results in the messages
    const toolResults = messages.filter(msg => msg.role === 'tool');
    const userMessages = messages.filter(msg => msg.role !== 'tool');

    // Create a prompt that includes the tool results
    let prompt = this.convertMessagesToPrompt(userMessages);

    if (toolResults.length > 0) {
      prompt += '\n\nTool Results:\n';
      toolResults.forEach((result, index) => {
        prompt += `Result ${index + 1}: ${result.content}\n`;
      });
      prompt += '\n' + this.responseConfig.toolResultsNonStreaming!.template!;
    }

    // Debug logging: Final response generation prompt
    this.logger.debug('TOOL RESULTS PROMPT (NON-STREAMING)', {
      originalMessageCount: messages.length,
      toolResultsCount: toolResults.length,
      userMessagesCount: userMessages.length,
      finalPrompt: prompt,
      promptLength: prompt.length,
      temperature: temperature,
      maxTokens: maxTokens
    });

    return await this.ollamaClient.sendToOllama(prompt, temperature, maxTokens);
  }

  async generateResponseWithToolResultsStreaming(
    messages: any[],
    temperature: number,
    maxTokens: number,
    res: any
  ): Promise<void> {
    // Find the tool results in the messages
    const toolResults = messages.filter(msg => msg.role === 'tool');
    const userMessages = messages.filter(msg => msg.role !== 'tool');

    // Create a prompt that includes the tool results
    let prompt = this.convertMessagesToPrompt(userMessages);

    if (toolResults.length > 0) {
      prompt += '\n\nTool Execution Results:\n';
      toolResults.forEach((result, index) => {
        const toolName = result.name || 'unknown_tool';
        const resultContent = result.content || '';
        const isEmpty = !resultContent.trim() || resultContent.length < 5;

        prompt += `Tool ${index + 1}: ${toolName}\n`;
        if (isEmpty) {
          prompt += `Status: Executed successfully but returned no results\n`;
        } else {
          prompt += `Status: Executed successfully with results\n`;
          prompt += `Output: ${resultContent}\n`;
        }
        prompt += '\n';
      });
      prompt += this.responseConfig.toolResultsStreaming!.template!;
    }

    // Debug logging: Final streaming response generation prompt
    this.logger.debug('TOOL RESULTS PROMPT (STREAMING)', {
      originalMessageCount: messages.length,
      toolResultsCount: toolResults.length,
      userMessagesCount: userMessages.length,
      promptLength: prompt.length,
      fullPrompt: prompt,
      temperature: temperature,
      maxTokens: maxTokens
    });

    await this.ollamaClient.sendToOllamaStreaming(prompt, temperature, maxTokens, res);
  }

  private estimateTokens(text: string): number {
    // Simple token estimation (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }
}
