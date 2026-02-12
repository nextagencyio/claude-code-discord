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
    async onClaude(ctx: any, prompt: string, sessionId?: string, channelSendFn?: (messages: ClaudeMessage[]) => Promise<void>): Promise<ClaudeResponse> {
      const send = channelSendFn || sendClaudeMessages;
      const currentWorkDir = resolveWorkDir();

      // Cancel any existing session
      if (deps.claudeController) {
        deps.claudeController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

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
      const result = await sendToClaudeCode(
        currentWorkDir,
        prompt,
        controller,
        sessionId,
        undefined, // onChunk callback not used
        (jsonData) => {
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
        deps.workspaceRootDir
      );

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

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
      }

      return result;
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