#!/usr/bin/env node

/**
 * Completion Testing Tool for Local MCP Hub
 * 
 * This tool analyzes completion requests captured in compreq.json,
 * generates the same prompt as the hub, and tests it against Ollama
 * to debug autocomplete behavior.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class CompletionTester {
  constructor() {
    this.config = this.loadConfig();
    this.compreqPath = path.join(__dirname, '..', '.tmp', 'compreq.json');
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, '..', 'config.json');
      const configData = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(configData);
    } catch (error) {
      console.error('Failed to load config.json:', error.message);
      process.exit(1);
    }
  }

  loadCompletionRequest() {
    try {
      if (!fs.existsSync(this.compreqPath)) {
        console.error('No .tmp/compreq.json found. Trigger a completion request in VS Code first.');
        process.exit(1);
      }
      const requestData = fs.readFileSync(this.compreqPath, 'utf-8');
      return JSON.parse(requestData);
    } catch (error) {
      console.error('Failed to load compreq.json:', error.message);
      process.exit(1);
    }
  }

  parseFIMRequest(prompt) {
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

  extractContext(fimRequest) {
    const lines = fimRequest.prefix.split('\n');
    const codeBeforeCursor = lines[lines.length - 1] || '';
    
    // Extract only the last file path for language context
    const filePathLines = lines
      .filter(line => line.trim().startsWith('// Path: '))
      .map(line => line.trim());
    const languageContext = filePathLines.length > 0 ? filePathLines[filePathLines.length - 1] : '';

    return { codeBeforeCursor, languageContext, filePathLines };
  }

  generatePrompt(context, fimRequest) {
    const { codeBeforeCursor, languageContext } = context;
    
    return `You are an efficient code completion assistant. Your goal is to save the developer time by writing as much useful, correct code as possible.

File: ${languageContext.replace('// Path: ', '')}
Code before cursor: ${codeBeforeCursor}
Code after cursor: ${fimRequest.suffix}

Your response must start with the exact text "${codeBeforeCursor}" character-for-character, then continue with your completion, and include the suffix "${fimRequest.suffix}". Provide a meaningful completion that implements or extends the code logically. Write clean, well-typed code.

IMPORTANT: Respond with plain text only. Do not use code blocks, markdown formatting, or backticks. Do not add explanations or comments after the code. Only provide the completed code.`;
  }

  async testWithOllama(prompt, temperature = 0.2, maxTokens = 4000) {
    return new Promise((resolve, reject) => {
      const curlArgs = [
        '-X', 'POST',
        `${this.config.ollama.host}/api/generate`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({
          model: this.config.ollama.model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: temperature,
            num_predict: maxTokens
          }
        })
      ];

      const curl = spawn('curl', curlArgs);
      let response = '';
      let errorOutput = '';

      curl.stdout.on('data', (data) => {
        response += data.toString();
      });

      curl.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      curl.on('close', (code) => {
        if (code === 0) {
          try {
            const ollamaResponse = JSON.parse(response);
            resolve(ollamaResponse.response);
          } catch (error) {
            reject(new Error(`Failed to parse Ollama response: ${error.message}`));
          }
        } else {
          reject(new Error(`Curl failed with code ${code}: ${errorOutput}`));
        }
      });

      curl.on('error', (error) => {
        reject(error);
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        curl.kill();
        reject(new Error('Request timeout'));
      }, 30000);
    });
  }

  analyzeResponse(rawResponse, expectedPrefix) {
    if (rawResponse.startsWith(expectedPrefix)) {
      const completion = rawResponse.slice(expectedPrefix.length);
      return {
        success: true,
        completion: completion,
        message: 'Response correctly starts with expected prefix'
      };
    } else {
      return {
        success: false,
        completion: rawResponse,
        message: 'Response does not start with expected prefix',
        expectedPrefix: expectedPrefix,
        actualStart: rawResponse.substring(0, expectedPrefix.length)
      };
    }
  }

  async run() {
    console.log('🔍 Local MCP Hub Completion Tester');
    console.log('=====================================\n');

    // Load and analyze request
    const requestData = this.loadCompletionRequest();
    console.log('📋 Original Request:');
    console.log(`  Model: ${requestData.model}`);
    console.log(`  Max tokens: ${requestData.max_tokens}`);
    console.log(`  Temperature: ${requestData.temperature}`);
    console.log(`  Stream: ${requestData.stream}`);
    console.log(`  Stop tokens: ${requestData.stop.length} tokens`);

    // Parse FIM
    const fimRequest = this.parseFIMRequest(requestData.prompt);
    console.log(`\n🎯 FIM Analysis:`);
    console.log(`  Is FIM: ${fimRequest.isFIM}`);
    if (fimRequest.isFIM) {
      console.log(`  Prefix length: ${fimRequest.prefix.length} chars`);
      console.log(`  Suffix: ${JSON.stringify(fimRequest.suffix)}`);
    }

    // Extract context
    const context = this.extractContext(fimRequest);
    console.log(`\n📁 Context Extraction:`);
    console.log(`  Code before cursor: ${JSON.stringify(context.codeBeforeCursor)}`);
    console.log(`  Language file: ${context.languageContext}`);
    console.log(`  File paths found: ${context.filePathLines.length}`);

    // Generate prompt
    const completionPrompt = this.generatePrompt(context, fimRequest);
    console.log(`\n📝 Generated Prompt:`);
    console.log(`  Length: ${completionPrompt.length} chars (~${Math.ceil(completionPrompt.length / 4)} tokens)`);
    console.log('─'.repeat(60));
    console.log(completionPrompt);
    console.log('─'.repeat(60));

    // Test with Ollama
    console.log(`\n🚀 Testing with Ollama (${this.config.ollama.host})...`);
    try {
      const rawResponse = await this.testWithOllama(
        completionPrompt, 
        requestData.temperature || 0.2, 
        requestData.max_tokens || 4000
      );

      console.log(`\n✅ Ollama Response:`);
      console.log('─'.repeat(60));
      console.log(rawResponse);
      console.log('─'.repeat(60));

      // Analyze response
      const analysis = this.analyzeResponse(rawResponse, context.codeBeforeCursor);
      console.log(`\n🔬 Response Analysis:`);
      console.log(`  Success: ${analysis.success ? '✅' : '❌'}`);
      console.log(`  Message: ${analysis.message}`);
      
      if (analysis.success) {
        console.log(`\n💡 Extracted Completion:`);
        console.log('─'.repeat(60));
        console.log(analysis.completion);
        console.log('─'.repeat(60));
      } else {
        console.log(`  Expected prefix: ${JSON.stringify(analysis.expectedPrefix)}`);
        console.log(`  Actual start: ${JSON.stringify(analysis.actualStart)}`);
      }

    } catch (error) {
      console.error(`\n❌ Ollama test failed: ${error.message}`);
    }
  }
}

// Run the tester
if (require.main === module) {
  const tester = new CompletionTester();
  tester.run().catch(console.error);
}

module.exports = CompletionTester;