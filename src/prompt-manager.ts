import winston from 'winston';
import fs from 'fs';
import path from 'path';

export interface PromptTemplate {
  template?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface PromptTemplates {
  // Tool selection
  'toolSelection.stage1'?: PromptTemplate;
  
  // Plan execution
  'responseGeneration.parallelTasks'?: PromptTemplate;
  'responseGeneration.planDecision'?: PromptTemplate;
  'responseGeneration.planIteration'?: PromptTemplate;
  'responseGeneration.finalIteration'?: PromptTemplate;
  'responseGeneration.stepLimitIteration'?: PromptTemplate;
  'responseGeneration.errorConclusion'?: PromptTemplate;
  'responseGeneration.currentStep'?: PromptTemplate;
  'responseGeneration.previousTool'?: PromptTemplate;
  'responseGeneration.previousStep'?: PromptTemplate;
  'responseGeneration.planDecisionAssistant'?: PromptTemplate;
  
  // System messages
  'systemMessages.customSystemPrompt'?: PromptTemplate & { enabled?: boolean };
  'systemMessages.mcpInitializing'?: PromptTemplate;
  'systemMessages.toolPermissionError'?: PromptTemplate;
  'systemMessages.toolPermissionRequest'?: PromptTemplate;
  
  // Code completion
  'codeCompletion.completion'?: PromptTemplate & { useFastModel?: boolean };
  
  // Connection test
  'connectionTest.main'?: PromptTemplate;
  'connectionTest.fast'?: PromptTemplate;
  
  // Argument generation
  'argumentGeneration.fastModel'?: PromptTemplate;
  'argumentGeneration.fullModel'?: PromptTemplate;
  
  // Tool guidance (special handling needed)
  'toolGuidance.usageHints'?: Record<string, string>;
  'toolGuidance.fastModelTools'?: string[];
  'toolGuidance.safeTools'?: string[];
  'toolGuidance.toolsBlackList'?: string[];
  'toolGuidance.argumentHints'?: Record<string, Record<string, string>>;
}

export class PromptManager {
  private templates: PromptTemplates = {};
  private logger: winston.Logger;
  private promptsPath: string;

  constructor(promptsPath: string, logger: winston.Logger) {
    this.promptsPath = promptsPath;
    this.logger = logger;
    this.loadPrompts();
  }

  /**
   * Get a prompt template by its key path
   */
  getTemplate(key: keyof PromptTemplates): PromptTemplate | undefined {
    const value = this.templates[key];
    if (typeof value === 'object' && !Array.isArray(value) && 'template' in value) {
      return value as PromptTemplate;
    }
    return undefined;
  }

  /**
   * Get the raw template string
   */
  getTemplateString(key: keyof PromptTemplates): string | undefined {
    const value = this.templates[key];
    if (typeof value === 'object' && !Array.isArray(value) && 'template' in value) {
      return (value as PromptTemplate).template;
    }
    return undefined;
  }

  /**
   * Get template with parameters
   */
  getTemplateWithParams(key: keyof PromptTemplates): { 
    template?: string; 
    temperature?: number; 
    maxTokens?: number 
  } | undefined {
    const value = this.templates[key];
    if (typeof value === 'object' && !Array.isArray(value) && ('template' in value || 'message' in value)) {
      return value as PromptTemplate;
    }
    return undefined;
  }

  /**
   * Get tool guidance configuration
   */
  getToolGuidance(): {
    usageHints?: Record<string, string>;
    fastModelTools?: string[];
    safeTools?: string[];
    toolsBlackList?: string[];
    argumentHints?: Record<string, Record<string, string>>;
  } {
    return {
      usageHints: this.templates['toolGuidance.usageHints'] as Record<string, string>,
      fastModelTools: this.templates['toolGuidance.fastModelTools'] as string[],
      safeTools: this.templates['toolGuidance.safeTools'] as string[],
      toolsBlackList: this.templates['toolGuidance.toolsBlackList'] as string[],
      argumentHints: this.templates['toolGuidance.argumentHints'] as Record<string, Record<string, string>>
    };
  }

  /**
   * Reload prompts from disk
   */
  reloadPrompts(): void {
    try {
      this.loadPrompts();
      this.logger.info('Prompts reloaded successfully');
    } catch (error) {
      this.logger.error('Failed to reload prompts:', error);
      throw error;
    }
  }

  private loadPrompts(): void {
    try {
      const promptsData = fs.readFileSync(this.promptsPath, 'utf-8');
      const prompts = JSON.parse(promptsData);
      
      // Clear existing templates
      this.templates = {};
      
      // Flatten the nested structure into dot-notation keys
      this.flattenPrompts(prompts, '');
      
      this.logger.info('Prompts loaded into cache', {
        templateCount: Object.keys(this.templates).length
      });
    } catch (error) {
      this.logger.error('Failed to load prompts:', error);
      throw error;
    }
  }

  private flattenPrompts(obj: any, prefix: string): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      
      if (value === null || value === undefined) {
        continue;
      }
      
      // Special handling for tool guidance arrays and objects
      if (fullKey.startsWith('toolGuidance.')) {
        this.templates[fullKey as keyof PromptTemplates] = value as any;
        continue;
      }
      
      // If it has a template property, it's a prompt template
      if (typeof value === 'object' && ('template' in value || 'message' in value)) {
        const templateObj = value as any;
        this.templates[fullKey as keyof PromptTemplates] = {
          template: templateObj.template || templateObj.message,
          temperature: templateObj.temperature,
          maxTokens: templateObj.maxTokens,
          useFastModel: templateObj.useFastModel,
          enabled: templateObj.enabled
        } as any;
      } 
      // Otherwise, recurse if it's an object
      else if (typeof value === 'object' && !Array.isArray(value)) {
        this.flattenPrompts(value, fullKey);
      }
    }
  }

  /**
   * Get all template keys (useful for debugging)
   */
  getAllTemplateKeys(): string[] {
    return Object.keys(this.templates);
  }
}