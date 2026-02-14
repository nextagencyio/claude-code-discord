import type { ClaudeResponse, ClaudeMessage } from "./types.ts";
import { sendToClaudeCode } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";

export interface ClaudeHandlerDeps {
  workDir: string | (() => string);
  workspaceRootDir?: string;
  claudeController: AbortController | null;
  setClaudeController: (controller: AbortController | null) => void;
  setClaudeSessionId: (sessionId: string | undefined) => void;
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  getDefaultModel?: () => string | undefined;
}

export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  const { sendClaudeMessages } = deps;
  const resolveWorkDir = () => typeof deps.workDir === 'function' ? deps.workDir() : deps.workDir;
  
  return {
    // deno-lint-ignore no-explicit-any
    async onClaude(ctx: any, prompt: string, sessionId?: string, channelSendFn?: (messages: ClaudeMessage[]) => Promise<void>, externalController?: AbortController, mcpServers?: Record<string, any>): Promise<ClaudeResponse> {
      const send = channelSendFn || sendClaudeMessages;
      const currentWorkDir = resolveWorkDir();

      // Use externally-provided controller (per-channel) or fall back to shared deps
      const controller = externalController || (() => {
        if (deps.claudeController) {
          deps.claudeController.abort();
        }
        const c = new AbortController();
        deps.setClaudeController(c);
        return c;
      })();

      // Defer interaction (execute first)
      await ctx.deferReply();

      // Send initial message
      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: 'Claude Code Running...',
          description: 'Waiting for response...',
          fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true
        }]
      });

      const defaultModel = deps.getDefaultModel?.();
      let streamMessageCount = 0;

      // Race the SDK call against a hard 30-second timeout
      // (controller.abort() alone may not break a blocking iterator)
      const STARTUP_TIMEOUT_MS = 30000;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(
            `TIMEOUT: Claude CLI produced no output after ${STARTUP_TIMEOUT_MS / 1000}s. ` +
            `The CLI may not be installed, not authenticated, or hanging. ` +
            `cwd=${currentWorkDir}`
          ));
        }, STARTUP_TIMEOUT_MS);
      });

      const queryPromise = sendToClaudeCode(
        currentWorkDir,
        prompt,
        controller,
        sessionId,
        undefined, // onChunk callback not used
        (jsonData) => {
          streamMessageCount++;
          // First message received — cancel the timeout
          if (streamMessageCount === 1 && timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          // Process JSON stream data and send to Discord
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            send(claudeMessages).catch((err) => {
              console.error('[Claude sender error]:', err instanceof Error ? err.message : String(err));
            });
          }
        },
        false, // continueMode = false
        defaultModel ? { model: defaultModel } : undefined,
        deps.workspaceRootDir,
        mcpServers
      );

      try {
        const result = await Promise.race([queryPromise, timeoutPromise]);

        // Clear timeout if query finished before timeout
        if (timeoutId) clearTimeout(timeoutId);

        if (!externalController) {
          deps.setClaudeSessionId(result.sessionId);
          deps.setClaudeController(null);
        }

        // Send completion message with interactive buttons
        if (result.sessionId) {
          await send([{
            type: 'system',
            content: '',
            metadata: {
              subtype: 'completion',
              session_id: result.sessionId,
              model: result.modelUsed || 'Default',
              total_cost_usd: result.cost,
              duration_ms: result.duration,
              cwd: currentWorkDir
            }
          }]);
        } else if (streamMessageCount === 0) {
          // No session ID and no stream messages — something went wrong silently
          const stderrPreview = result.stderrOutput ? result.stderrOutput.substring(0, 800) : 'none';
          const fields = [
            { name: 'Working Directory', value: `\`${currentWorkDir}\``, inline: false },
            { name: 'Model', value: result.modelUsed || 'Default', inline: true },
            { name: 'Response', value: `\`${(result.response || 'empty').substring(0, 200)}\``, inline: false },
          ];
          if (stderrPreview !== 'none') {
            fields.push({ name: 'stderr', value: `\`\`\`\n${stderrPreview}\n\`\`\``, inline: false });
          }
          await ctx.editReply({
            embeds: [{
              color: 0xff0000,
              title: 'Claude Code - No Response',
              description: 'Claude Code returned without producing any output. Check that the CLI is installed and authenticated on the server.',
              fields,
              timestamp: true
            }]
          });
        }

        return result;
      // deno-lint-ignore no-explicit-any
      } catch (error: any) {
        // Clear timeout on error path too
        if (timeoutId) clearTimeout(timeoutId);

        if (!externalController) {
          deps.setClaudeController(null);
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        const stderrOutput = error.stderrOutput || '';
        console.error('[onClaude] sendToClaudeCode error:', errorMsg);

        const fields = [
          { name: 'Working Directory', value: `\`${currentWorkDir}\``, inline: false },
          { name: 'Stream Messages Received', value: `${streamMessageCount}`, inline: true },
        ];
        if (stderrOutput) {
          fields.push({ name: 'stderr', value: `\`\`\`\n${stderrOutput.substring(0, 800)}\n\`\`\``, inline: false });
        }

        // Post error directly to Discord via ctx (which always works)
        await ctx.editReply({
          embeds: [{
            color: 0xff0000,
            title: 'Claude Code Error',
            description: `\`\`\`\n${errorMsg.substring(0, 1500)}\n\`\`\``,
            fields,
            timestamp: true
          }]
        });

        return { response: errorMsg, modelUsed: defaultModel || 'Default' };
      }
    },
    
    // deno-lint-ignore no-explicit-any
    async onContinue(ctx: any, prompt?: string): Promise<ClaudeResponse> {
      const currentWorkDir = resolveWorkDir();

      // Cancel any existing session
      if (deps.claudeController) {
        deps.claudeController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const actualPrompt = prompt || "Please continue.";

      // Defer interaction
      await ctx.deferReply();

      // Send initial message
      const embedData: { color: number; title: string; description: string; timestamp: boolean; fields?: Array<{ name: string; value: string; inline: boolean }> } = {
        color: 0xffff00,
        title: 'Claude Code Continuing Conversation...',
        description: 'Loading latest conversation and waiting for response...',
        timestamp: true
      };

      if (prompt) {
        embedData.fields = [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }];
      }

      await ctx.editReply({ embeds: [embedData] });

      const continueDefaultModel = deps.getDefaultModel?.();
      const result = await sendToClaudeCode(
        currentWorkDir,
        actualPrompt,
        controller,
        undefined, // sessionId not used
        undefined, // onChunk callback not used
        (jsonData) => {
          // Process JSON stream data and send to Discord
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            sendClaudeMessages(claudeMessages).catch((err) => {
              console.error('[Claude sender error]:', err instanceof Error ? err.message : String(err));
            });
          }
        },
        true, // continueMode = true
        continueDefaultModel ? { model: continueDefaultModel } : undefined,
        deps.workspaceRootDir
      );

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

      // Send completion message with interactive buttons
      if (result.sessionId) {
        await sendClaudeMessages([{
          type: 'system',
          content: '',
          metadata: {
            subtype: 'completion',
            session_id: result.sessionId,
            model: result.modelUsed || 'Default',
            total_cost_usd: result.cost,
            duration_ms: result.duration,
            cwd: currentWorkDir
          }
        }]);
      }

      return result;
    },
    
    // deno-lint-ignore no-explicit-any
    onClaudeCancel(_ctx: any): boolean {
      if (!deps.claudeController) {
        return false;
      }
      
      console.log("Cancelling Claude Code session...");
      deps.claudeController.abort();
      deps.setClaudeController(null);
      deps.setClaudeSessionId(undefined);
      
      return true;
    }
  };
}