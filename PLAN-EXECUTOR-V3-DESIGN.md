# Plan Executor V3 Design

## Overview

Plan Executor V3 is designed to address the cognitive overload issues identified in V1 and V2 by breaking down complex decision-making into simple, discrete steps. The goal is to reduce the burden on LLMs by giving each model call a single, clear task instead of expecting complex multi-step reasoning.

## Core Problems V3 Solves

### Issues with V1/V2:
1. **Cognitive Overload**: Single prompts asking LLMs to make 6+ categories of complex decisions
2. **Information Drowning**: Massive README content overwhelming the original user question
3. **Circular Reasoning**: LLMs ignoring past findings and repeating failed approaches
4. **Fast Model Misuse**: 0.5B parameter models expected to do PhD-level reasoning
5. **Plan Detection Failures**: Complex JSON plans not being recognized or executed

## V3 Architecture

### Design Principles:
1. **One Decision Per Call**: Each LLM interaction has exactly one clear, simple task
2. **Simplified Classification**: Use A/B/C/D choices instead of complex reasoning
3. **Deterministic Mapping**: Use rule-based logic after simple classifications
4. **Reduced Context**: Keep user questions prominent, minimize information overload
5. **Graceful Fallbacks**: Always produce some response even if classification fails

### Workflow:

```
User Question → Intent Classification → Info Type → Tool Mapping → Execute → Evaluate → Respond
```

#### Step 1: Intent Classification (Fast Model)
**Task**: "What does the user want to DO?"
- Input: User request only
- Output: Single letter (A/B/C/D/E)
- Options:
  - A) UNDERSTAND - Learn how something works
  - B) FIND - Locate specific information  
  - C) FIX - Debug/troubleshoot issues
  - D) BUILD - Implement/create features
  - E) CONFIGURE - Setup/modify settings

#### Step 2: Information Type Classification (Fast Model)  
**Task**: "What type of information do they need?"
- Input: User request + Intent from Step 1 + File list (first 20 files only)
- Output: Single letter (A/B/C/D)
- Options:
  - A) OVERVIEW - Documentation, README
  - B) SOURCE - Implementation code
  - C) CONFIG - Configuration files
  - D) EXPLORE - Directory structure

#### Step 3: Deterministic Tool Mapping (No LLM)
**Task**: Map Intent + Info Type → Tool + Target
- Pure rule-based logic
- Example mappings:
  - UNDERSTAND + OVERVIEW → `read_file README.md`
  - FIND + SOURCE → `search_for_pattern src/`
  - FIX + CONFIG → `read_file config.json`

#### Step 4: Tool Execution
**Current Implementation**: Uses existing ToolSelector (PROBLEM - see Issues)
**Intended Design**: Simple argument generation based on deterministic mapping

#### Step 5: Simple Evaluation (Full Model)
**Task**: "Does this answer the user's question? Y/N"
- Input: User question + Tool result (truncated to 2000 chars)
- Output: Binary decision + optional next action
- Much simpler than V1/V2's complex plan generation

#### Step 6: Response Generation (Full Model)
**Task**: Generate final answer based on gathered information
- Input: User question + Relevant information found
- Output: Direct answer to user's question

## Current Implementation Status

### ✅ Completed:
- Intent classification with simple A/B/C/D/E choices
- Information type classification with A/B/C/D choices  
- Deterministic tool mapping logic
- Simple binary evaluation instead of complex reasoning
- Hub integration and configuration support

### ❌ Current Issues:

#### Issue 1: Still Using Heavy ToolSelector
V3 currently calls:
```typescript
this.toolSelector.generateArgsWithFastModel()
this.toolSelector.generateArgsWithFullModel()
```

These methods use the same complex `argumentGeneration` prompts from V1/V2:
- Extract arguments from user request based on tool requirements
- Consider parameter relationships and validation  
- Apply complex path resolution logic
- Handle optional parameter filtering

**Problem**: V3 already knows exactly what it wants (e.g., `read_file README.md`), so complex argument generation is unnecessary overhead.

#### Issue 2: No Direct Tool Argument Generation
V3 should generate simple arguments directly:
```typescript
// Instead of complex reasoning, just:
if (tool === 'read_file' && target === 'README.md') {
  return { args: { file_path: 'README.md' } };
}
```

#### Issue 3: Still Vulnerable to Context Overload
While V3 reduces some complexity, it still processes full project file lists and tool results without careful context management.

## Proposed Fixes

### 1. Implement Native Argument Generation
Replace ToolSelector calls with simple, direct argument generation:

```typescript
private generateToolArguments(tool: string, target: string): any {
  switch(tool) {
    case 'read_file':
      return { file_path: target };
    case 'search_for_pattern':  
      return { pattern: target, path: '.' };
    case 'list_dir':
      return { path: target || '.' };
    case 'find_file':
      return { file_mask: target };
    default:
      throw new Error(`Unsupported tool: ${tool}`);
  }
}
```

### 2. Improve Context Management
- Limit project file lists to essential files only
- Truncate tool results more aggressively  
- Keep user question prominent in every step

### 3. Add Better Error Handling
- Graceful degradation when classifications fail
- Sensible defaults for each step
- Clear logging for debugging

## Expected Behavior for "Hot-reload Prompts" Question

With V3 properly implemented:

1. **Intent**: UNDERSTAND (A) - User wants to learn how something works
2. **Info Type**: OVERVIEW (A) - Need documentation/general understanding  
3. **Tool**: `read_file README.md` - Deterministic mapping
4. **Args**: `{file_path: "README.md"}` - Simple, direct generation
5. **Evaluation**: README mentions `/v1/admin/reload-prompts` → YES, answers question
6. **Response**: "Yes, you can hot-reload prompts using the `/v1/admin/reload-prompts` endpoint..."

No complex reasoning, no information overload, no circular logic - just simple, step-by-step progress toward the answer.

## Comparison with V1/V2

| Aspect | V1/V2 | V3 |
|--------|-------|----| 
| **Decisions per call** | 6+ complex categories | 1 simple choice |
| **Fast model usage** | Heavy reasoning (broken) | Simple A/B/C classification |
| **Tool selection** | Complex stage1 + argument generation | Intent → Info → Deterministic mapping |
| **Plan detection** | Complex JSON parsing + execution | No plans needed - direct execution |
| **Context management** | Full README dumps | Minimal, focused context |
| **Error handling** | Complex plan failures | Simple fallbacks at each step |
| **Debugging** | Opaque plan execution | Clear step-by-step logging |

V3 represents a fundamental architectural shift from "smart prompts doing complex reasoning" to "simple prompts + intelligent orchestration."