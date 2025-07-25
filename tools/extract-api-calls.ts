#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: any;
}

interface UserRequest {
  timestamp: string;
  content: string;
  index: number;
}

interface ApiCall {
  timestamp: string;
  type: 'http' | 'mcp' | 'ollama';
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  response?: any;
  duration?: string;
  error?: string;
}

class ApiCallExtractor {
  private allCalls: ApiCall[] = [];
  public userRequests: UserRequest[] = [];
  
  /**
   * Convert text to block quote format by prepending '>' to each line
   */
  private toBlockQuote(text: string): string {
    return text.split('\n').map(line => `> ${line}`).join('\n');
  }
  
  async findUserRequests(logPath: string): Promise<void> {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const entry: LogEntry = JSON.parse(line);
        
        // Detect user requests from HTTP chat completions
        if (entry.message === 'HTTP REQUEST DETAILS' && entry.path === '/v1/chat/completions') {
          // Look ahead for the request body
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            const nextLine = lines[j].trim();
            if (nextLine) {
              try {
                const nextEntry = JSON.parse(nextLine);
                if (nextEntry.fullRequestBody?.messages) {
                  const userMessage = nextEntry.fullRequestBody.messages.find((m: any) => m.role === 'user');
                  if (userMessage) {
                    this.userRequests.push({
                      timestamp: entry.timestamp,
                      content: userMessage.content,
                      index: i
                    });
                  }
                }
              } catch (e) {
                // Not JSON, skip
              }
            }
          }
        }
      } catch (e) {
        // Not valid JSON, skip
      }
    }
  }

  async extractConversation(logPath: string, requestIndex: number): Promise<ApiCall[]> {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.split('\n');
    const calls: ApiCall[] = [];
    
    // Find the selected request
    const selectedRequest = this.userRequests.find(r => r.index === requestIndex);
    if (!selectedRequest) {
      throw new Error('Invalid request index');
    }
    
    const startTime = new Date(selectedRequest.timestamp).getTime();
    const endTime = startTime + (10 * 60 * 1000); // 10 minutes window
    let streamClosed = false;
    
    let currentHttpRequest: Partial<ApiCall> | null = null;
    let currentOllamaRequest: Partial<ApiCall> | null = null;
    let lastMcpRequest: ApiCall | null = null;
    
    for (let i = requestIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const entry: LogEntry = JSON.parse(line);
        const entryTime = new Date(entry.timestamp).getTime();
        
        // Stop if we're too far from the original request or stream has closed
        if (entryTime > endTime || streamClosed) break;
        
        // Detect when the chat completion request ends
        if (entry.message === 'Timing: Total chat completion request completed') {
          streamClosed = true;
          continue; // Process this entry but stop after
        }
        
        // Initial HTTP request
        if (i === requestIndex && entry.message === 'HTTP REQUEST DETAILS') {
          // Look ahead for the request body
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            const nextLine = lines[j].trim();
            if (nextLine) {
              try {
                const nextEntry = JSON.parse(nextLine);
                if (nextEntry.fullRequestBody) {
                  calls.push({
                    timestamp: entry.timestamp,
                    type: 'http',
                    method: entry.method,
                    url: entry.path,
                    headers: entry.headers,
                    body: nextEntry.fullRequestBody
                  });
                  break;
                }
              } catch (e) {
                // Not JSON, skip
              }
            }
          }
        }
        
        // Extract MCP tool calls
        if (entry.message?.includes('MCP JSON-RPC REQUEST')) {
          const mcpRequest = entry.message.match(/\{.*\}/)?.[0];
          if (mcpRequest) {
            try {
              const parsed = JSON.parse(mcpRequest);
              const mcpCall: ApiCall = {
                timestamp: entry.timestamp,
                type: 'mcp',
                method: parsed.method,
                body: parsed,
                url: `MCP/${entry.mcpName}/${entry.toolName || 'unknown'}`
              };
              calls.push(mcpCall);
              lastMcpRequest = mcpCall;
            } catch (e) {
              console.error('Failed to parse MCP request:', e);
            }
          }
        }
        
        // Extract MCP responses
        if (entry.message?.includes('MCP JSON-RPC RESPONSE') && lastMcpRequest) {
          lastMcpRequest.response = {
            hasResult: entry.hasResult,
            hasError: entry.hasError,
            resultSize: entry.resultSize
          };
        }
        
        // Tool results
        if (entry.message?.startsWith('TOOL RESULT DEBUG:') && entry.fullResult) {
          const toolName = entry.message.split(':')[1]?.trim();
          const matchingCall = calls.filter(c => 
            c.type === 'mcp' && 
            c.timestamp === entry.timestamp &&
            (c.url?.includes(toolName) || c.body?.params?.name === toolName)
          ).pop();
          
          if (matchingCall) {
            matchingCall.response = {
              ...matchingCall.response,
              result: entry.fullResult
            };
          }
        }
        
        // Extract Ollama requests
        if (entry.message === 'OLLAMA HTTP REQUEST') {
          currentOllamaRequest = {
            timestamp: entry.timestamp,
            type: 'ollama',
            method: entry.method || 'POST',
            url: entry.url,
            body: entry.body || {}
          };
          
          // Add model info
          if (entry.model) {
            currentOllamaRequest.body.model = entry.model;
          }
          
          // Store prompt length info if truncated
          if (entry.promptLength && currentOllamaRequest.body.prompt) {
            currentOllamaRequest.body._promptLength = entry.promptLength;
            currentOllamaRequest.body._promptTruncated = currentOllamaRequest.body.prompt.length < entry.promptLength;
          }
        }
        
        // Extract Ollama responses
        if (entry.message === 'OLLAMA HTTP RESPONSE' && currentOllamaRequest) {
          currentOllamaRequest.response = {
            status: entry.status,
            model: entry.model,
            responseLength: entry.responseLength
          };
          
          // Extract response content from body if available
          if (entry.body?.response) {
            currentOllamaRequest.response.content = entry.body.response;
          }
          
          // Calculate duration if available
          if (entry.body?.total_duration) {
            currentOllamaRequest.duration = `${Math.round(entry.body.total_duration / 1000000)}ms`;
          }
          
          calls.push(currentOllamaRequest as ApiCall);
          currentOllamaRequest = null;
        }
        
        // Timing information
        if (entry.message?.startsWith('Timing:') && entry.duration) {
          const operation = entry.message.replace('Timing:', '').replace('completed', '').trim();
          // Find the most recent call that matches this operation
          for (let j = calls.length - 1; j >= 0; j--) {
            const call = calls[j];
            if (!call.duration && 
                (call.url?.includes(operation) || 
                 call.body?.params?.name?.includes(operation) ||
                 operation.includes('Stage') || 
                 operation.includes('tool selection'))) {
              call.duration = entry.duration;
              break;
            }
          }
        }
        
      } catch (e) {
        // Not valid JSON, skip
      }
    }
    
    return calls;
  }

  generateMarkdown(calls: ApiCall[], userRequest: string): string {
    let md = `# API Calls Documentation - Extracted Conversation
*Generated: ${new Date().toISOString().split('T')[0]}*

## User Request
${this.toBlockQuote(userRequest)}

`;

    let phaseCounter = 1;
    let iterationCounter = 1;
    let lastPhase = '';

    for (const call of calls) {
      // Determine phase based on call content
      let currentPhase = '';
      if (call.type === 'http' && call.url === '/v1/chat/completions') {
        currentPhase = 'Initial Request';
      } else if (call.type === 'mcp' && call.url?.includes('list_dir') && phaseCounter === 1) {
        currentPhase = 'System Context Building';
      } else if (call.type === 'ollama' && call.body?.prompt?.includes('INFORMATION GATHERING PHASE')) {
        currentPhase = 'Tool Selection (Stage 1)';
      } else if (call.type === 'ollama' && (call.body?.prompt?.includes('TOOL ARGUMENT GENERATION') || 
                                               call.body?.prompt?.includes('Generate tool arguments from user request'))) {
        currentPhase = 'Argument Generation (Stage 2)';
      } else if (call.type === 'mcp' && lastPhase.includes('Argument Generation')) {
        currentPhase = 'Tool Execution';
      } else if (call.type === 'ollama' && call.body?.prompt?.includes('Based on the assistant tool results')) {
        currentPhase = 'Plan Decision';
      } else if (call.type === 'ollama' && call.body?.prompt?.includes('Current Step:')) {
        currentPhase = `Plan Iteration ${iterationCounter++}`;
      }

      if (currentPhase && currentPhase !== lastPhase) {
        md += `\n## Phase ${phaseCounter++}: ${currentPhase}\n\n`;
        lastPhase = currentPhase;
      }

      // Format the call
      md += `### ${call.type.toUpperCase()} Call\n\n`;
      md += `**Timestamp**: ${call.timestamp}\n\n`;

      if (call.type === 'http') {
        md += `**Request**:\n`;
        md += this.toBlockQuote(`${call.method} ${call.url} HTTP/1.1`);
        md += '\n';
        if (call.headers) {
          const importantHeaders = ['host', 'content-type', 'authorization', 'user-agent'];
          for (const [key, value] of Object.entries(call.headers)) {
            if (importantHeaders.includes(key.toLowerCase())) {
              md += this.toBlockQuote(`${key}: ${value}`) + '\n';
            }
          }
        }
        md += this.toBlockQuote('') + '\n';
        md += this.toBlockQuote(JSON.stringify(call.body, null, 2)) + '\n\n';
      } else if (call.type === 'mcp') {
        md += `**Tool**: ${call.url}\n\n`;
        md += `**Request**:\n`;
        md += this.toBlockQuote(JSON.stringify(call.body, null, 2)) + '\n\n';
        if (call.response?.result) {
          md += `**Response**:\n`;
          try {
            const parsed = JSON.parse(call.response.result);
            md += this.toBlockQuote(JSON.stringify(parsed, null, 2)) + '\n';
          } catch {
            md += this.toBlockQuote(call.response.result) + '\n';
          }
        }
        if (call.duration) {
          md += `\n**Duration**: ${call.duration}\n`;
        }
        md += '\n';
      } else if (call.type === 'ollama') {
        md += `**Model**: ${call.body?.model || 'Unknown'}\n`;
        if (call.body?.options) {
          md += `**Parameters**: temperature=${call.body.options.temperature || 'default'}`;
          if (call.body.options.num_predict) {
            md += `, max_tokens=${call.body.options.num_predict}`;
          }
          md += '\n';
        }
        md += '\n';
        
        if (call.body?.prompt) {
          const prompt = call.body.prompt;
          const isTruncated = call.body._promptTruncated;
          md += `**Prompt**${isTruncated ? ' (truncated in logs)' : ''}:\n`;
          md += this.toBlockQuote(prompt) + '\n\n';
        }
        
        if (call.response?.content) {
          md += `**Response**:\n`;
          try {
            const parsed = JSON.parse(call.response.content);
            md += this.toBlockQuote(JSON.stringify(parsed, null, 2)) + '\n';
          } catch {
            md += this.toBlockQuote(call.response.content) + '\n';
          }
        }
        if (call.duration) {
          md += `\n**Duration**: ${call.duration}\n`;
        }
        md += '\n';
      }
    }

    md += `\n## Summary\n\n`;
    md += `**Total API Calls**: ${calls.length}\n`;
    md += `**MCP Tool Calls**: ${calls.filter(c => c.type === 'mcp').length}\n`;
    md += `**Ollama LLM Calls**: ${calls.filter(c => c.type === 'ollama').length}\n`;
    md += `**HTTP Requests**: ${calls.filter(c => c.type === 'http').length}\n`;

    return md;
  }
}

// Interactive prompt
async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error('Usage: extract-api-calls.ts <log-file> [output-file]');
    console.error('Example: extract-api-calls.ts .tmp/local-mcp-hub.log API_CALLS3.md');
    process.exit(1);
  }

  const logFile = args[0];
  const outputFile = args[1];

  if (!fs.existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  console.log(`Analyzing log file: ${logFile}\n`);
  
  const extractor = new ApiCallExtractor();
  
  try {
    // Find all user requests
    await extractor.findUserRequests(logFile);
    
    if (extractor.userRequests.length === 0) {
      console.error('No user requests found in the log file');
      process.exit(1);
    }
    
    // Display found requests
    console.log(`Found ${extractor.userRequests.length} user requests:\n`);
    extractor.userRequests.forEach((req, idx) => {
      const preview = req.content.length > 100 
        ? req.content.substring(0, 100) + '...' 
        : req.content;
      console.log(`[${idx + 1}] ${req.timestamp}`);
      console.log(`    ${preview}\n`);
    });
    
    // Ask user to select
    const selection = await promptUser('Select request number to extract (or "all" for all requests): ');
    
    if (selection.toLowerCase() === 'all') {
      // Extract all conversations
      for (let i = 0; i < extractor.userRequests.length; i++) {
        const req = extractor.userRequests[i];
        const calls = await extractor.extractConversation(logFile, req.index);
        const markdown = extractor.generateMarkdown(calls, req.content);
        const filename = outputFile || `API_CALLS_${i + 1}.md`;
        await writeFile(filename, markdown);
        console.log(`Extracted conversation ${i + 1} to: ${filename} (${calls.length} API calls)`);
      }
    } else {
      // Extract selected conversation
      const selectedIdx = parseInt(selection) - 1;
      if (selectedIdx < 0 || selectedIdx >= extractor.userRequests.length) {
        console.error('Invalid selection');
        process.exit(1);
      }
      
      const req = extractor.userRequests[selectedIdx];
      const calls = await extractor.extractConversation(logFile, req.index);
      const markdown = extractor.generateMarkdown(calls, req.content);
      const filename = outputFile || 'API_CALLS_EXTRACTED.md';
      
      await writeFile(filename, markdown);
      console.log(`\nAPI calls documentation written to: ${filename}`);
      console.log(`Extracted ${calls.length} API calls from the selected conversation`);
    }
  } catch (error) {
    console.error('Error extracting API calls:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { ApiCallExtractor };