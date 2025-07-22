import winston from 'winston';

export interface OllamaConfig {
  host: string;
  model: string;
  fast_model: string;
}

export class OllamaClient {
  private config: OllamaConfig;
  private logger: winston.Logger;

  constructor(config: OllamaConfig, logger: winston.Logger) {
    this.config = config;
    this.logger = logger;
  }

  async sendToOllama(
    prompt: string,
    temperature: number,
    maxTokens?: number,
    useFastModel: boolean = false
  ): Promise<string> {
    const model = useFastModel ? this.config.fast_model : this.config.model;
    try {
      const options: any = { temperature };
      if (maxTokens !== undefined) {
        options.num_predict = maxTokens;
      }

      const requestBody = {
        model: model,
        prompt: prompt,
        stream: false,
        options,
      };

      // Debug logging: Complete HTTP request to Ollama
      this.logger.debug('OLLAMA HTTP REQUEST', {
        url: `${this.config.host}/api/generate`,
        method: 'POST',
        body: requestBody,
        promptLength: prompt.length,
        model: model,
        useFastModel: useFastModel
      });

      const response = await fetch(`${this.config.host}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();

      // Debug logging: Complete HTTP response from Ollama
      this.logger.debug('OLLAMA HTTP RESPONSE', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: data,
        responseLength: data.response?.length || 0,
        model: model
      });

      if (!data.response) {
        throw new Error('No response from Ollama');
      }

      return data.response;
    } catch (error) {
      this.logger.error(`Failed to communicate with Ollama (${model}):`, error);
      throw error;
    }
  }

  async sendToOllamaStreaming(
    prompt: string,
    temperature: number,
    maxTokens: number,
    res: any,
    useFastModel: boolean = false
  ): Promise<void> {
    const model = useFastModel ? this.config.fast_model : this.config.model;

    try {
      this.logger.info('Starting Ollama streaming response');

      // Set SSE headers immediately
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      const requestBody = {
        model: model,
        prompt: prompt,
        stream: true, // Enable true streaming
        options: {
          temperature: temperature,
          num_predict: maxTokens,
        },
      };

      // Debug logging: Complete streaming HTTP request to Ollama
      this.logger.debug('OLLAMA STREAMING HTTP REQUEST', {
        url: `${this.config.host}/api/generate`,
        method: 'POST',
        body: requestBody,
        promptLength: prompt.length,
        model: model,
        useFastModel: useFastModel
      });

      const response = await fetch(`${this.config.host}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('No response body from Ollama');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');

          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim()) {
              try {
                const data = JSON.parse(line);

                if (data.response) {
                  // Send streaming chunk to Continue
                  const streamChunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: data.response },
                        finish_reason: null,
                      },
                    ],
                  };

                  // Debug logging: Individual streaming chunk (throttled)
                  if (totalTokens % 10 === 0 || data.response.length > 10) {
                    this.logger.debug('OLLAMA STREAM CHUNK', {
                      chunkContent: data.response,
                      chunkNumber: totalTokens + 1,
                      model: model
                    });
                  }

                  res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
                  totalTokens++;
                }

                if (data.done) {
                  // Send final chunk
                  const finalChunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: 'stop',
                      },
                    ],
                    usage: {
                      prompt_tokens: this.estimateTokens(prompt),
                      completion_tokens: totalTokens,
                      total_tokens: this.estimateTokens(prompt) + totalTokens,
                    },
                  };

                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
                  return;
                }
              } catch (e) {
                this.logger.warn('Failed to parse Ollama streaming response:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      this.logger.error(`Failed to stream from Ollama (${model}):`, error);

      // Send error response
      const errorChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {
              content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
            finish_reason: 'stop',
          },
        ],
      };

      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  async testConnection(testConfig: any): Promise<void> {
    try {
      this.logger.info('Testing connection to remote Ollama...');

      // Test main model
      const mainTestConfig = testConfig.connectionTest.main;
      const response = await this.sendToOllama(
        mainTestConfig.message!,
        mainTestConfig.temperature,
        mainTestConfig.maxTokens,
        mainTestConfig.useFastModel
      );
      this.logger.info(`✓ Main model (${this.config.model}) connection successful`);
      this.logger.info(`✓ Response: ${response.substring(0, 100)}...`);

      // Test fast model
      const fastTestConfig = testConfig.connectionTest.fast;
      const fastResponse = await this.sendToOllama(
        fastTestConfig.message!,
        fastTestConfig.temperature,
        fastTestConfig.maxTokens,
        fastTestConfig.useFastModel
      );
      this.logger.info(`✓ Fast model (${this.config.fast_model}) connection successful`);
      this.logger.info(`✓ Fast response: ${fastResponse.substring(0, 50)}...`);
    } catch (error) {
      this.logger.error('✗ Failed to connect to Ollama:', error);
      this.logger.error(
        'Please ensure Ollama is running on the remote server and both models are available'
      );
    }
  }

  private estimateTokens(text: string): number {
    // Simple token estimation (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }
}
