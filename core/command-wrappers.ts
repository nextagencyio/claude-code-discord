/**
 * Command handler wrappers for Discord bot commands.
 * Only the 4 active slash commands: /new, /cancel, /model, /status
 *
 * @module core/command-wrappers
 */

import type { CommandHandlers, InteractionContext } from "../discord/index.ts";
import type { AllHandlers, MessageHistoryOps } from "./handler-registry.ts";
import type { ProcessCrashHandler, ProcessHealthMonitor } from "../process/index.ts";

// ================================
// Types
// ================================

/**
 * Dependencies for command wrapper creation.
 */
export interface CommandWrapperDeps {
  /** All handler modules */
  handlers: AllHandlers;
  /** Message history operations */
  messageHistory: MessageHistoryOps;
  /** Get current Claude controller */
  getClaudeController: () => AbortController | null;
  /** Get current Claude session ID */
  getClaudeSessionId: () => string | undefined;
  /** Set Claude session ID */
  setClaudeSessionId?: (sessionId: string | undefined) => void;
  /** Set active channel ID for per-channel session routing */
  setActiveChannelId?: (channelId: string) => void;
  /** Get current channel's working directory */
  getClaudeWorkDir?: () => string;
  /** Crash handler for error reporting */
  crashHandler: ProcessCrashHandler;
  /** Health monitor */
  healthMonitor: ProcessHealthMonitor;
  /** Bot settings */
  botSettings: { mentionEnabled: boolean; mentionUserId: string | null };
  /** Cleanup interval ID */
  cleanupInterval: number;
}

// ================================
// Master Command Handler Factory
// ================================

/**
 * Create all command handlers for the 4 active slash commands.
 */
export function createAllCommandHandlers(deps: CommandWrapperDeps): CommandHandlers {
  const { handlers, getClaudeController, getClaudeSessionId } = deps;
  const { claude: claudeHandlers, advancedSettings: advancedSettingsHandlers } = handlers;

  // Helper: set active channel from ctx before running handler logic
  function setChannel(ctx: InteractionContext) {
    if (ctx.channelId && deps.setActiveChannelId) {
      deps.setActiveChannelId(ctx.channelId);
    }
  }

  const commandHandlers: CommandHandlers = new Map();

  // /new - Clear session and start fresh (for this channel)
  commandHandlers.set("new", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      claudeHandlers.onClaudeCancel(ctx);
      if (deps.setClaudeSessionId) {
        deps.setClaudeSessionId(undefined);
      }
      await ctx.reply({
        embeds: [{
          color: 0x00ff00,
          title: "Session Cleared",
          description: "Session has been reset for this channel. Your next message will start a fresh conversation.",
          timestamp: true,
        }],
      });
    },
  });

  // /cancel - Cancel running session (for this channel)
  commandHandlers.set("cancel", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      const cancelled = claudeHandlers.onClaudeCancel(ctx);
      await ctx.reply({
        embeds: [{
          color: cancelled ? 0xff0000 : 0x808080,
          title: cancelled ? "Cancelled" : "Nothing to Cancel",
          description: cancelled
            ? "Claude Code session cancelled."
            : "No running Claude Code session in this channel.",
          timestamp: true,
        }],
      });
    },
  });

  // /model - Quick model switch
  commandHandlers.set("model", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      const model = ctx.getString("model", true)!;
      await advancedSettingsHandlers.onQuickModel(ctx, model);
    },
  });

  // /status - Show current channel session info
  commandHandlers.set("status", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      const sessionId = getClaudeSessionId();
      const controller = getClaudeController();
      const isRunning = controller !== null && !controller.signal.aborted;
      const channelWorkDir = deps.getClaudeWorkDir ? deps.getClaudeWorkDir() : "Unknown";

      await ctx.reply({
        embeds: [{
          color: 0x0099ff,
          title: "Channel Status",
          fields: [
            {
              name: "Channel",
              value: ctx.channelId ? `<#${ctx.channelId}>` : "Unknown",
              inline: true,
            },
            { name: "Status", value: isRunning ? "Running" : "Idle", inline: true },
            {
              name: "Session",
              value: sessionId ? `\`${sessionId.substring(0, 20)}...\`` : "No active session",
              inline: false,
            },
            { name: "Working Directory", value: `\`${channelWorkDir}\``, inline: false },
          ],
          timestamp: true,
        }],
      });
    },
  });

  return commandHandlers;
}
