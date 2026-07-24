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
  /** Get the provider name for the active channel */
  getChannelProvider?: () => string | undefined;
  /** Set the provider name for the active channel */
  setChannelProvider?: (name: string | undefined) => void;
  /** Get the default provider name */
  getDefaultProviderName?: () => string;
  /** Get list of available provider names */
  getAvailableProviderNames?: () => string[];
  /** Get the model override for the active channel */
  getChannelModel?: () => string | undefined;
  /** Set the model override for the active channel */
  setChannelModel?: (model: string | undefined) => void;
  /** Get the global default model (from unified settings) */
  getGlobalDefaultModel?: () => string | undefined;
  /** Look up a provider by name (for listing its models) */
  getProvider?: (name: string) => { listModels?: () => Promise<{ id: string; name: string; description: string; recommended?: boolean }[]>; isAvailable?: () => Promise<boolean> } | undefined;
}

// ================================
// Master Command Handler Factory
// ================================

/**
 * Create all command handlers for the 4 active slash commands.
 */
export function createAllCommandHandlers(deps: CommandWrapperDeps): CommandHandlers {
  const { handlers, getClaudeController, getClaudeSessionId } = deps;
  const { claude: claudeHandlers } = handlers;

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
      if (cancelled) parts.push("AI Bot session cancelled.");
      if (cleared > 0) parts.push(`${cleared} queued message(s) cleared.`);
      if (!cancelled && cleared === 0) parts.push("No running AI Bot session in this channel.");
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

  // /model - Switch or list models for the active channel's provider
  // Free-text input (no static choices) because model IDs differ across
  // providers and Discord caps choices at 25. Called with no argument, lists
  // the models available to the channel's current provider.
  commandHandlers.set("model", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      const providerName = deps.getChannelProvider?.() || deps.getDefaultProviderName?.() || "claude-code";
      const model = ctx.getString("model"); // optional now

      // No argument → list models for the active provider
      if (!model) {
        const provider = deps.getProvider?.(providerName);
        const models = provider?.listModels ? await provider.listModels() : [];
        const currentModel = deps.getChannelModel?.() || deps.getGlobalDefaultModel?.() || "default";

        if (models.length === 0) {
          await ctx.reply({
            embeds: [{
              color: 0x0099ff,
              title: `Models for ${providerName}`,
              description: "No model list available for this provider.\nUse `/model model:<id>` to set any model ID the provider accepts.",
              fields: [
                { name: "Current", value: `\`${currentModel}\``, inline: true },
              ],
              timestamp: true,
            }],
          });
          return;
        }

        const modelList = models.map((m) => {
          const marker = m.id === currentModel ? "✅ " : (m.recommended ? "⭐ " : "");
          return `${marker}**${m.name}** (\`${m.id}\`)\n${m.description}`;
        }).join("\n\n");

        await ctx.reply({
          embeds: [{
            color: 0x0099ff,
            title: `Models for ${providerName}`,
            description: modelList,
            fields: [
              { name: "Current", value: `\`${currentModel}\``, inline: true },
              { name: "Provider", value: `\`${providerName}\``, inline: true },
            ],
            footer: { text: "Use /model model:<id> to switch. Any ID the provider accepts works." },
            timestamp: true,
          }],
        });
        return;
      }

      // Set the model for this channel
      if (deps.setChannelModel) {
        deps.setChannelModel(model);
      }

      await ctx.reply({
        embeds: [{
          color: 0x00ff00,
          title: "Model Switched",
          description: `This channel will now use **\`${model}\`** with the **${providerName}** provider.\nUse \`/new\` to start a fresh session with the new model.`,
          fields: [
            { name: "Model", value: `\`${model}\``, inline: true },
            { name: "Provider", value: `\`${providerName}\``, inline: true },
          ],
          timestamp: true,
        }],
      });
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
      const providerName = deps.getChannelProvider?.() || deps.getDefaultProviderName?.() || "claude-code";
      const modelName = deps.getChannelModel?.() || deps.getGlobalDefaultModel?.() || "default";

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
            { name: "Provider", value: `\`${providerName}\``, inline: true },
            { name: "Model", value: `\`${modelName}\``, inline: true },
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

  // /provider - Switch or check the AI provider for this channel
  commandHandlers.set("provider", {
    execute: async (ctx: InteractionContext) => {
      setChannel(ctx);
      const action = ctx.getString("action", true)!;
      const defaultName = deps.getDefaultProviderName?.() || "claude-code";
      const available = deps.getAvailableProviderNames?.() || ["claude-code"];
      const current = deps.getChannelProvider?.() || defaultName;

      switch (action) {
        case "list": {
          // Check availability of each provider (async)
          const availability: Record<string, boolean> = {};
          for (const name of available) {
            const provider = deps.getProvider?.(name);
            availability[name] = provider?.isAvailable ? await provider.isAvailable() : true;
          }

          const providerList = available.map((name) => {
            const isCurrent = name === current;
            const isDefault = name === defaultName;
            const isAvailable = availability[name];
            const markers = [
              isCurrent ? "✅ current" : "",
              isDefault ? "⭐ default" : "",
              isAvailable ? "" : "⚠️ not installed",
            ].filter(Boolean).join(" | ");
            return `**${name}**${markers ? ` — ${markers}` : ""}`;
          }).join("\n");

          await ctx.reply({
            embeds: [{
              color: 0x0099ff,
              title: "Available Providers",
              description: providerList || "No providers available.",
              fields: [
                { name: "Current", value: `\`${current}\``, inline: true },
                { name: "Default", value: `\`${defaultName}\``, inline: true },
              ],
              timestamp: true,
            }],
          });
          break;
        }

        case "set": {
          const name = ctx.getString("name");
          if (!name) {
            await ctx.reply({
              embeds: [{
                color: 0xff0000,
                title: "Missing Provider Name",
                description: "Please specify a provider name using the `name` option.\nAvailable providers: " + available.join(", "),
                timestamp: true,
              }],
            });
            break;
          }

          if (!available.includes(name)) {
            await ctx.reply({
              embeds: [{
                color: 0xff0000,
                title: "Invalid Provider",
                description: `Provider \`${name}\` is not available.\nAvailable providers: ${available.join(", ")}`,
                timestamp: true,
              }],
            });
            break;
          }

          // Warn if the provider's CLI isn't installed/authenticated, but
          // still switch — the user may install the CLI after switching.
          const provider = deps.getProvider?.(name);
          const isAvailable = provider?.isAvailable ? await provider.isAvailable() : true;

          if (deps.setChannelProvider) {
            deps.setChannelProvider(name);
          }

          // Clear the per-channel model override — model IDs are provider-specific
          // (e.g. Claude's "claude-opus-4-8" is invalid for Devin which uses
          // "claude-opus-4.8"). The user should /model to pick a new one.
          if (deps.setChannelModel) {
            deps.setChannelModel(undefined);
          }

          if (!isAvailable) {
            await ctx.reply({
              embeds: [{
                color: 0xffaa00,
                title: "Provider Switched (with warning)",
                description: `This channel will now use **${name}**, but its CLI doesn't appear to be installed or authenticated. Messages will fail until the CLI is available.\nRun \`/provider list\` to check status.`,
                timestamp: true,
              }],
            });
            break;
          }

          await ctx.reply({
            embeds: [{
              color: 0x00ff00,
              title: "Provider Switched",
              description: `This channel will now use **${name}** as its AI provider.\nThe model override was cleared (model IDs are provider-specific). Use \`/model\` to pick a model, then \`/new\` to start a fresh session.`,
              timestamp: true,
            }],
          });
          break;
        }

        case "status": {
          await ctx.reply({
            embeds: [{
              color: 0x0099ff,
              title: "Provider Status",
              fields: [
                { name: "Current Provider", value: `\`${current}\``, inline: true },
                { name: "Default Provider", value: `\`${defaultName}\``, inline: true },
                { name: "Available", value: available.join(", "), inline: false },
              ],
              timestamp: true,
            }],
          });
          break;
        }
      }
    },
  });

  return commandHandlers;
}
