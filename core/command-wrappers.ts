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
  /** Clear the message queue for the active channel, returns number of cleared messages */
  clearChannelQueue?: () => number;
  /** Get MCP servers for the active channel */
  // deno-lint-ignore no-explicit-any
  getChannelMcpServers?: () => Record<string, any> | undefined;
  /** Set MCP servers for the active channel */
  // deno-lint-ignore no-explicit-any
  setChannelMcpServers?: (servers: Record<string, any> | undefined) => void;
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
      const cleared = deps.clearChannelQueue ? deps.clearChannelQueue() : 0;
      if (deps.setClaudeSessionId) {
        deps.setClaudeSessionId(undefined);
      }
      const desc = cleared > 0
        ? `Session has been reset for this channel. ${cleared} queued message(s) were also cleared.`
        : "Session has been reset for this channel. Your next message will start a fresh conversation.";
      await ctx.reply({
        embeds: [{
          color: 0x00ff00,
          title: "Session Cleared",
          description: desc,
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
      const cleared = deps.clearChannelQueue ? deps.clearChannelQueue() : 0;
      const parts: string[] = [];
      if (cancelled) parts.push("Claude Code session cancelled.");
      if (cleared > 0) parts.push(`${cleared} queued message(s) cleared.`);
      if (!cancelled && cleared === 0) parts.push("No running Claude Code session in this channel.");
      await ctx.reply({
        embeds: [{
          color: (cancelled || cleared > 0) ? 0xff0000 : 0x808080,
          title: (cancelled || cleared > 0) ? "Cancelled" : "Nothing to Cancel",
          description: parts.join(" "),
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

  // /browser - Manage Chrome CDP connection for authenticated browser control
  commandHandlers.set("browser", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      const action = ctx.getString("action", true)!;
      const port = ctx.getInteger("port") || 9222;

      switch (action) {
        case "connect": {
          const mcpConfig = {
            playwright: {
              command: "npx",
              args: ["@playwright/mcp@latest", "--cdp-endpoint", `http://localhost:${port}`],
            },
          };

          // Verify Chrome is reachable before saving
          try {
            const resp = await fetch(`http://localhost:${port}/json/version`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const info = await resp.json();

            if (deps.setChannelMcpServers) {
              deps.setChannelMcpServers(mcpConfig);
            }

            await ctx.reply({
              embeds: [{
                color: 0x00ff00,
                title: "Browser Connected",
                description: `Claude can now interact with your Chrome browser.\nPlaywright MCP will connect via CDP on port ${port}.`,
                fields: [
                  { name: "Browser", value: info.Browser || "Unknown", inline: true },
                  { name: "Port", value: `${port}`, inline: true },
                  { name: "Protocol", value: info["Protocol-Version"] || "Unknown", inline: true },
                ],
                timestamp: true,
              }],
            });
          } catch {
            await ctx.reply({
              embeds: [{
                color: 0xff0000,
                title: "Connection Failed",
                description: `Could not reach Chrome on port ${port}.\n\nMake sure Chrome is running with remote debugging:\n\`\`\`\ngoogle-chrome --remote-debugging-port=${port}\n\`\`\``,
                timestamp: true,
              }],
            });
          }
          break;
        }

        case "disconnect": {
          if (deps.setChannelMcpServers) {
            deps.setChannelMcpServers(undefined);
          }
          await ctx.reply({
            embeds: [{
              color: 0xffaa00,
              title: "Browser Disconnected",
              description: "Playwright MCP server removed. Claude will no longer have browser access in this channel.",
              timestamp: true,
            }],
          });
          break;
        }

        case "tabs": {
          // Check if connected first
          const currentServers = deps.getChannelMcpServers?.();
          const cdpArg = currentServers?.playwright?.args?.find((a: string) => a.startsWith("http://"));
          const cdpPort = cdpArg ? new URL(cdpArg).port : String(port);

          try {
            const resp = await fetch(`http://localhost:${cdpPort}/json/list`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            // deno-lint-ignore no-explicit-any
            const tabs: any[] = await resp.json();
            const pageTabs = tabs.filter(t => t.type === "page");

            if (pageTabs.length === 0) {
              await ctx.reply({
                embeds: [{
                  color: 0x808080,
                  title: "No Tabs Found",
                  description: `Chrome on port ${cdpPort} has no open page tabs.`,
                  timestamp: true,
                }],
              });
            } else {
              const tabList = pageTabs.slice(0, 15).map((t, i) =>
                `**${i + 1}.** [${(t.title || "Untitled").substring(0, 60)}](${(t.url || "").substring(0, 100)})`
              ).join("\n");

              await ctx.reply({
                embeds: [{
                  color: 0x0099ff,
                  title: `Browser Tabs (${pageTabs.length})`,
                  description: tabList,
                  fields: currentServers?.playwright
                    ? [{ name: "Status", value: "Connected — Claude has browser access", inline: false }]
                    : [{ name: "Status", value: "Not connected — use `/browser connect` first", inline: false }],
                  timestamp: true,
                }],
              });
            }
          } catch {
            await ctx.reply({
              embeds: [{
                color: 0xff0000,
                title: "Cannot List Tabs",
                description: `Could not reach Chrome on port ${cdpPort}.\n\nMake sure Chrome is running with:\n\`\`\`\ngoogle-chrome --remote-debugging-port=${cdpPort}\n\`\`\``,
                timestamp: true,
              }],
            });
          }
          break;
        }

        case "status": {
          const servers = deps.getChannelMcpServers?.();
          const isConnected = !!servers?.playwright;

          if (!isConnected) {
            await ctx.reply({
              embeds: [{
                color: 0x808080,
                title: "Browser Status",
                description: "Not connected. Use `/browser connect` to attach Claude to your Chrome browser.",
                timestamp: true,
              }],
            });
          } else {
            const cdpEndpoint = servers.playwright.args?.find((a: string) => a.startsWith("http://")) || "Unknown";
            const cdpStatusPort = new URL(cdpEndpoint).port;

            let browserInfo = "Unknown";
            let tabCount = "?";
            try {
              const vResp = await fetch(`http://localhost:${cdpStatusPort}/json/version`);
              if (vResp.ok) {
                const info = await vResp.json();
                browserInfo = info.Browser || "Unknown";
              }
              const tResp = await fetch(`http://localhost:${cdpStatusPort}/json/list`);
              if (tResp.ok) {
                // deno-lint-ignore no-explicit-any
                const tabs: any[] = await tResp.json();
                tabCount = `${tabs.filter(t => t.type === "page").length}`;
              }
            } catch {
              browserInfo = "Unreachable";
            }

            await ctx.reply({
              embeds: [{
                color: 0x00ff00,
                title: "Browser Status",
                description: "Connected — Claude has browser access in this channel.",
                fields: [
                  { name: "Browser", value: browserInfo, inline: true },
                  { name: "CDP Endpoint", value: `\`${cdpEndpoint}\``, inline: true },
                  { name: "Open Tabs", value: tabCount, inline: true },
                ],
                timestamp: true,
              }],
            });
          }
          break;
        }
      }
    },
  });

  return commandHandlers;
}
