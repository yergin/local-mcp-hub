export interface FIMRequest {
  prefix: string;
  suffix: string;
  isFIM: boolean;
}

export interface CompletionContext {
  language: string;
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

  static detectLanguage(prefix: string, suffix: string): string {
    const fullText = prefix + suffix;
    
    // C++ indicators
    if (fullText.includes('#include') || fullText.includes('std::') || 
        fullText.includes('namespace') || /\w+::\w+/.test(fullText) ||
        fullText.includes('.cpp') || fullText.includes('.hpp') || fullText.includes('.h')) {
      return 'cpp';
    }
    
    // Python indicators  
    if (fullText.includes('def ') || fullText.includes('import ') ||
        fullText.includes('from ') || fullText.includes('__init__') ||
        fullText.includes('.py') || /^\s*#/.test(fullText)) {
      return 'python';
    }
    
    // TypeScript indicators
    if (fullText.includes('interface ') || fullText.includes(': string') ||
        fullText.includes(': number') || fullText.includes('async ') ||
        fullText.includes('.ts') || fullText.includes('export ') ||
        fullText.includes('import {')) {
      return 'typescript';
    }
    
    // Default fallback
    return 'unknown';
  }

  static createCompletionContext(prefix: string, suffix: string): CompletionContext {
    const language = this.detectLanguage(prefix, suffix);
    
    // Clean up the prefix to get actual code context
    const lines = prefix.split('\n');
    const codeLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//') && !trimmed.startsWith('Path:');
    });
    const cleanPrefix = codeLines.slice(-8).join('\n'); // Last 8 lines of actual code
    
    return { language, prefix, suffix, cleanPrefix };
  }

  static createCompletionPrompt(context: CompletionContext): string {
    const { language, cleanPrefix, suffix } = context;
    
    switch (language) {
      case 'cpp':
        return CppCompletions.createPrompt(cleanPrefix, suffix);
      case 'python':
        return PythonCompletions.createPrompt(cleanPrefix, suffix);
      case 'typescript':
        return TypeScriptCompletions.createPrompt(cleanPrefix, suffix);
      default:
        return GenericCompletions.createPrompt(cleanPrefix, suffix);
    }
  }
}

class CppCompletions {
  static createPrompt(prefix: string, suffix: string): string {
    return `You are completing C++ code. Return ONLY the missing code that should be inserted at the cursor position. Do not repeat any existing code.

Code before cursor:
${prefix}

Code after cursor:
${suffix}

Insert only the missing code:`;
  }
}

class PythonCompletions {
  static createPrompt(prefix: string, suffix: string): string {
    return `You are completing Python code. Return ONLY the missing code that should be inserted at the cursor position. Do not repeat any existing code.

Code before cursor:
${prefix}

Code after cursor:
${suffix}

Insert only the missing code:`;
  }
}

class TypeScriptCompletions {
  static createPrompt(prefix: string, suffix: string): string {
    return `You are completing TypeScript code. Return ONLY the missing code that should be inserted at the cursor position. Do not repeat any existing code.

Code before cursor:
${prefix}

Code after cursor:
${suffix}

Insert only the missing code:`;
  }
}

class GenericCompletions {
  static createPrompt(prefix: string, suffix: string): string {
    return `You are completing code. Return ONLY the missing code that should be inserted at the cursor position. Do not repeat any existing code.

Code before cursor:
${prefix}

Code after cursor:
${suffix}

Insert only the missing code:`;
  }
}