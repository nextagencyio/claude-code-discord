import { query as claudeQuery, type SDKMessage, type CanUseTool } from "@anthropic-ai/claude-code";
import { resolve, normalize, sep } from "node:path";

/**
 * Create a canUseTool guard that restricts file writes to the workspace directory.
 * Read and execute operations are allowed everywhere.
 */
function createWorkspaceWriteGuard(workspaceRootDir: string, cwd: string): CanUseTool {
  const normalizedRoot = normalize(resolve(workspaceRootDir));

  return async (toolName: string, input: Record<string, unknown>) => {
    // Write-capable tools and their path input keys
    const writeToolPaths: Record<string, string> = {
      'Write': 'file_path',
      'Edit': 'file_path',
      'NotebookEdit': 'notebook_path',
    };

    const pathKey = writeToolPaths[toolName];
    if (pathKey) {
      const filePath = input[pathKey] as string;
      if (filePath) {
        const resolvedPath = normalize(resolve(cwd, filePath));
        if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(normalizedRoot + sep)) {
          console.warn(`[Security] Blocked write outside workspace: ${toolName} -> ${filePath} (resolved: ${resolvedPath})`);
          return {
            behavior: 'deny' as const,
            message: `Write operations are restricted to the workspace directory (${workspaceRootDir}). The path "${filePath}" is outside the allowed area. You can read files outside workspace but cannot write to them.`,
          };
        }
      }
    }

    return { behavior: 'allow' as const, updatedInput: input };
  };
}

// Clean session ID (remove unwanted characters)
export function cleanSessionId(sessionId: string): string {
  return sessionId
    .trim()                           // Remove leading/trailing whitespace
    .replace(/^`+|`+$/g, '')         // Remove leading/trailing backticks
    .replace(/^```\n?|\n?```$/g, '') // Remove code block markers
    .replace(/[\r\n]/g, '')          // Remove line breaks
    .trim();                         // Remove whitespace again
}

// Model options for Claude Code
// NOTE: Only model selection is supported by the CLI
export interface ClaudeModelOptions {
  model?: string;
}

// Wrapper for Claude Code SDK query function
export async function sendToClaudeCode(
  workDir: string,
  prompt: string,
  controller: AbortController,
  sessionId?: string,
  onChunk?: (text: string) => void,
  // deno-lint-ignore no-explicit-any
  onStreamJson?: (json: any) => void,
  continueMode?: boolean,
  modelOptions?: ClaudeModelOptions,
  workspaceRootDir?: string
): Promise<{
  response: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  modelUsed?: string;
  stderrOutput?: string;
}> {
  const messages: SDKMessage[] = [];
  let fullResponse = "";
  let resultSessionId: string | undefined;
  let modelUsed = modelOptions?.model || "Default";
  
  // Clean up session ID
  const cleanedSessionId = sessionId ? cleanSessionId(sessionId) : undefined;
  
  // Captured stderr output for diagnostics
  const stderrLines: string[] = [];

  // Wrap with comprehensive error handling
  const executeWithErrorHandling = async (overrideModel?: string, skipResume?: boolean) => {
    try {
      // Determine which model to use
      const modelToUse = overrideModel || modelOptions?.model;
      const shouldResume = cleanedSessionId && !continueMode && !skipResume;

      const queryOptions = {
        prompt,
        abortController: controller,
        options: {
          cwd: workDir,
          pathToClaudeCodeExecutable: Deno.env.get("CLAUDE_PATH") || "claude",
          permissionMode: "bypassPermissions" as const,
          ...(workspaceRootDir && { canUseTool: createWorkspaceWriteGuard(workspaceRootDir, workDir) }),
          verbose: true,
          outputFormat: "stream-json",
          ...(continueMode && { continue: true }),
          ...(shouldResume && { resume: cleanedSessionId }),
          ...(modelToUse && { model: modelToUse }),
          stderr: (data: string) => {
            stderrLines.push(data);
            console.error(`[Claude Code stderr]: ${data}`);
          },
        },
      };

      console.log(`Claude Code: Running with ${modelToUse || 'default'} model in cwd: ${workDir}`);
      if (continueMode) {
        console.log(`Continue mode: Reading latest conversation in directory`);
      } else if (shouldResume) {
        console.log(`Session resuming with ID: ${cleanedSessionId}`);
      } else if (cleanedSessionId && skipResume) {
        console.log(`Skipping session resume (previous attempt failed), starting fresh`);
      }

      console.log(`Claude Code: Creating query iterator...`);
      const iterator = claudeQuery(queryOptions);
      console.log(`Claude Code: Iterator created, starting to read messages...`);
      const currentMessages: SDKMessage[] = [];
      let currentResponse = "";
      let currentSessionId: string | undefined;
      let messageCount = 0;

      // Startup timeout: abort if no first message within 30 seconds
      const STARTUP_TIMEOUT = 30000;
      // Activity timeout: abort if no messages for 5 minutes (handles hung CLI)
      const ACTIVITY_TIMEOUT = 5 * 60 * 1000;

      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const resetActivityTimeout = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (!controller.signal.aborted) {
          timeoutId = setTimeout(() => {
            if (!controller.signal.aborted) {
              console.error(`Claude Code: ACTIVITY TIMEOUT — no messages for ${ACTIVITY_TIMEOUT / 1000}s after ${messageCount} messages. Aborting.`);
              controller.abort();
            }
          }, ACTIVITY_TIMEOUT);
        }
      };

      // Start with the startup timeout
      if (!controller.signal.aborted) {
        timeoutId = setTimeout(() => {
          if (messageCount === 0 && !controller.signal.aborted) {
            const stderrSummary = stderrLines.join('\n').substring(0, 500);
            console.error(`Claude Code: STARTUP TIMEOUT — no messages received after ${STARTUP_TIMEOUT / 1000}s. stderr: ${stderrSummary}`);
            controller.abort();
          }
        }, STARTUP_TIMEOUT);
      }

      for await (const message of iterator) {
        messageCount++;
        if (messageCount === 1) {
          console.log(`Claude Code: First message received (type: ${message.type})`);
        }
        // Reset activity timeout on every message
        resetActivityTimeout();
        // Check AbortSignal to stop iteration
        if (controller.signal.aborted) {
          console.log(`Claude Code: Abort signal detected, stopping iteration`);
          break;
        }

        currentMessages.push(message);

        // For JSON streams, call dedicated callback
        if (onStreamJson) {
          onStreamJson(message);
        }

        // For text messages, send chunks
        // Skip for JSON stream output as it's handled by onStreamJson
        if (message.type === 'assistant' && message.message.content && !onStreamJson) {
          const textContent = message.message.content
            // deno-lint-ignore no-explicit-any
            .filter((c: any) => c.type === 'text')
            // deno-lint-ignore no-explicit-any
            .map((c: any) => c.text)
            .join('');

          if (textContent && onChunk) {
            onChunk(textContent);
          }
          currentResponse = textContent;
        }

        // Save session information
        if ('session_id' in message && message.session_id) {
          currentSessionId = message.session_id;
        }
      }

      // Clear any pending timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      console.log(`Claude Code: Iterator finished. Total messages: ${messageCount}, sessionId: ${currentSessionId || 'none'}`);

      return {
        messages: currentMessages,
        response: currentResponse,
        sessionId: currentSessionId,
        aborted: controller.signal.aborted,
        modelUsed: modelToUse || "Default",
        stderrOutput: stderrLines.join('\n'),
      };
    // deno-lint-ignore no-explicit-any
    } catch (error: any) {
      // Properly handle process exit code 143 (SIGTERM) and AbortError
      if (error.name === 'AbortError' ||
          controller.signal.aborted ||
          (error.message && error.message.includes('exited with code 143'))) {
        console.log(`Claude Code: Process terminated by abort signal`);
        return {
          messages: [],
          response: "",
          sessionId: undefined,
          aborted: true,
          modelUsed: "Default",
          stderrOutput: stderrLines.join('\n'),
        };
      }
      // Attach stderr to the error for the caller
      error.stderrOutput = stderrLines.join('\n');
      throw error;
    }
  };
  
  // First try with specified model (or default)
  try {
    const result = await executeWithErrorHandling();
    
    if (result.aborted) {
      return { response: "Request was cancelled", modelUsed: result.modelUsed, stderrOutput: result.stderrOutput };
    }

    messages.push(...result.messages);
    fullResponse = result.response;
    resultSessionId = result.sessionId;
    modelUsed = result.modelUsed;

    // Get information from the last message
    const lastMessage = messages[messages.length - 1];

    return {
      response: fullResponse || "No response received",
      sessionId: resultSessionId,
      cost: 'total_cost_usd' in lastMessage ? lastMessage.total_cost_usd : undefined,
      duration: 'duration_ms' in lastMessage ? lastMessage.duration_ms : undefined,
      modelUsed,
      stderrOutput: result.stderrOutput,
    };
  // deno-lint-ignore no-explicit-any
  } catch (error: any) {
    // For exit code 1 errors, retry without session resume (may be a bad session)
    // and fall back to Sonnet 4 as the model
    if (error.message && (error.message.includes('exit code 1') || error.message.includes('exited with code 1'))) {
      console.log("Exit code 1 detected — retrying with Sonnet 4 (without session resume)...");

      try {
        const retryResult = await executeWithErrorHandling("claude-sonnet-4-20250514", true);
        
        if (retryResult.aborted) {
          return { response: "Request was cancelled", modelUsed: retryResult.modelUsed };
        }
        
        // Get information from the last message
        const lastRetryMessage = retryResult.messages[retryResult.messages.length - 1];
        
        return {
          response: retryResult.response || "No response received",
          sessionId: retryResult.sessionId,
          cost: 'total_cost_usd' in lastRetryMessage ? lastRetryMessage.total_cost_usd : undefined,
          duration: 'duration_ms' in lastRetryMessage ? lastRetryMessage.duration_ms : undefined,
          modelUsed: retryResult.modelUsed
        };
      // deno-lint-ignore no-explicit-any
      } catch (retryError: any) {
        // If Sonnet 4 also fails
        if (retryError.name === 'AbortError' || 
            controller.signal.aborted || 
            (retryError.message && retryError.message.includes('exited with code 143'))) {
          return { response: "Request was cancelled", modelUsed: "Claude Sonnet 4" };
        }
        
        retryError.message += '\n\n⚠️ Both default model and Sonnet 4 encountered errors. Please wait a moment and try again.';
        throw retryError;
      }
    }
    
    throw error;
  }
}