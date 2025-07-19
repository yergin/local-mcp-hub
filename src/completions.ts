export interface FIMRequest {
  prefix: string;
  suffix: string;
  isFIM: boolean;
}

export interface CompletionContext {
  prefix: string;
  suffix: string;
  cleanPrefix: string;
}

export class CompletionHandler {
  static parseFIMRequest(prompt: string): FIMRequest {
    // Check if this is a FIM (Fill-In-Middle) request
    if (!prompt.includes('<fim_prefix>') || !prompt.includes('<fim_suffix>')) {
      return { prefix: prompt, suffix: '', isFIM: false };
    }

    // Extract the prefix and suffix from the FIM format
    const prefixMatch = prompt.match(/<fim_prefix>(.*?)<fim_suffix>/s);
    const suffixMatch = prompt.match(/<fim_suffix>(.*?)<fim_middle>/s);
    
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const suffix = suffixMatch ? suffixMatch[1] : '';
    
    return { prefix, suffix, isFIM: true };
  }


  static createCompletionContext(prefix: string, suffix: string): CompletionContext {
    // Clean up the prefix to get actual code context
    const lines = prefix.split('\n');
    const codeLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//') && !trimmed.startsWith('Path:');
    });
    const cleanPrefix = codeLines.slice(-8).join('\n'); // Last 8 lines of actual code
    
    return { prefix, suffix, cleanPrefix };
  }

  static createCompletionPrompt(context: CompletionContext): string {
    const { cleanPrefix, suffix } = context;
    return `<PRE> ${cleanPrefix} <SUF>${suffix} <MID>`;
  }
}

