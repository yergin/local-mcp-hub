Idea for planning and producing responses using MCPs over multiple iterations
=============================================================================

The start of the process is the same as it is now:

1. User writes an agent prompt in Continue
2. Hub receives a chat completion request and sends a tool selection prompt to the fast model
3. Hub receives chosen tool and sends it of to the fast or full model for argument generation (if a tool was chosen)
4. Hub runs the chosen tool.

Now this is where the process changes:

5. The full model is given the user prompt and the tool result and the list of all available tools and has two choices:

    a. The full model judges that it has enough information to satisfy the user's query, responds and ends the chat (as is the case now).

    b. The full model judges that it can provide a better assistance after running more tools. In this case, the models described its main objective and produces a plan which is a list of steps. The model selects the tool for the first step in the process and creates a prompt stating unambiguously which arguments need to be provided to the tool. The model formats the plan, main objective and tool prompt in such a way (JSON for example) that the hub reads it as a plan and does not a terminating response:

    ```json
    {
        "main_objective": "Do Y",
        "next_step": {
            "purpose": "Look up X",
            "tool": "search_for_pattern",
            "prompt": "Look for X within the files in folder src.",
        },
        "future_steps": [
            "Use results of X to do Y",
            "Review Y"
        ]
    }
    ```

6. The user's prompt, the model's main objective and plan are streamed to Continue so that the user has some early feedback:

    ```md
    A plan has been created where the objective is: Do Y

    - Look up X
    - Use results of X to do Y
    - Review Y
    ```

7. A section is added to the document for the next step and streamed to the user:

    ```md
    l
    Look up X
    ---------
    ```

7. The tool and its prompt sent to the fast or full model for argument generation.

8. The hub runs the tool.

9. The result sent to the full model along with the user's prompt, the model's main objective and plan, tool results and conclusions from past steps, a list of available tools and it is asked to formulate a response drawing conclusions from the past step, whether it wants to conclude and end the chat, change the next step or future steps in the plan, selecting the tool for the next step and creating a prompt stating unambiguously which arguments need to be provided to the tool in the format:

    ```json
    {
        "main_objective": "Do Y",
        "current_step_conclusion": "X found but it would be good to search for Z too",
        "next_step": {
            "purpose": "Look up Z",
            "tool": "search_for_pattern",
            "prompt": "Look for Z within the files in folder src.",
        },
        "future_steps": [
            "Use results of X and Z to do Y.",
            "Review Y"
        ]
    }
    ```

10. The hub receives the JSON and...

    a. If the next_step is absent, the hub will stream the current_step_conclusion and end the chat:

    ```md
    Final conclusion reached
    ------------------------

    (...)
    ```

    b. current_step_conclusion is streamed to the user along with any changes to the plan and the tool and its prompt sent to the fast or full model for argument generation. Go to step 8.

## Issues Identified for Future Prompt Engineering Improvements

### 1. Fast Model Argument Generation - Regex vs Glob Pattern Issue

**Problem**: The fast model generates regex patterns instead of glob patterns for the `find_file` tool, causing it to only match hidden files.

**Example**: 
- Fast model generates: `{"args": {"file_mask": ".*", "relative_path": "."}}`
- Should generate: `{"args": {"file_mask": "*", "relative_path": "."}}`

**Impact**: The `find_file` tool with regex pattern ".*" only returns hidden files (`.prettierignore`, `.prettierrc`, `.gitignore`) instead of all files, leading to poor tool results.

**Location**: `prompts.json` - `argumentGeneration.fastModel.template` needs better guidance to use glob patterns instead of regex patterns.

### 2. Full Model Context Recognition Issue

**Problem**: The full model fails to recognize project type despite having complete directory context showing clear TypeScript/Node.js indicators.

**Evidence**: In the plan decision prompt, the full model received:
```json
{
  "dirs": ["src", ".continue", ".serena"], 
  "files": ["config.json", "install.sh", "OPTIMIZATION_RESULTS.md", "restart-hub.sh", "tsconfig.json", "API_CALLS.md", "LICENSE", "TIMING_ANALYSIS.md", "package-lock.json", ".prettierignore", ".prettierrc", "README.md", "continue-config.yaml", "PLAN.md", "install-mac.sh", "package.json", "install.bat", ".gitignore", "prompts.json"]
}
```

**Clear indicators present**:
- `tsconfig.json` (TypeScript project)
- `package.json` (Node.js project)
- `src` directory (source code)

**Response**: Model still responded with `"assistant_data_was_helpful": false` and failed to identify the project as TypeScript/Node.js.

**Location**: `prompts.json` - `responseGeneration.planDecision.template` may need better instructions for recognizing project types from directory listings.