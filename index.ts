#!/usr/bin/env -S deno run --allow-all

/**
 * AI Bot - Main Entry Point
 * 
 * This file bootstraps the Discord bot with AI CLI integration.
 * Most command handlers are now extracted to core modules for maintainability.
 * 
 * @module index
 */

import {
  createDiscordBot,
  convertMessageContent,
  type BotConfig,
  type InteractionContext,
  type CommandHandlers,
  type ButtonHandlers,
  type BotDependencies,
  type MessageContent,
} from "./discord/index.ts";

import { getGitInfo } from "./git/index.ts";
import { createClaudeSender, expandableContent, type DiscordSender, type ClaudeMessage, convertToClaudeMessages } from "./claude/index.ts";
import { DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS } from "./settings/index.ts";
import { cleanupPaginationStates } from "./discord/index.ts";
import { createProviderRegistry, getDefaultProviderName, type AIProvider, type ProviderRegistry } from "./providers/index.ts";

// Core modules - now handle most of the heavy lifting
import {
  parseArgs,
  createMessageHistory,
  createBotManagers,
  setupPeriodicCleanup,
  createBotSettings,
  createAllHandlers,
  getAllCommands,
  cleanSessionId,
  createButtonHandlers,
  createExpandButtonHandler,
  createAllCommandHandlers,
  type BotManagers,
  type AllHandlers,
  type MessageHistoryOps,
} from "./core/index.ts";

// Re-export for backward compatibility
export { getGitInfo, executeGitCommand } from "./git/index.ts";
export { sendToClaudeCode } from "./claude/index.ts";

// ================================
// Bot Creation
// ================================

/**
 * Create AI Bot with all handlers and integrations.
 */
export async function createClaudeCodeBot(config: BotConfig) {
  const { discordToken, applicationId, workDir, repoName, branchName, categoryName, defaultMentionUserId } = config;
  
  // Determine category name (use repository name if not specified)
  const actualCategoryName = categoryName || repoName;
  
  // Per-channel session management: each channel has its own session and folder
  interface QueuedMessage {
    ctx: InteractionContext;
    prompt: string;
  }
  interface ChannelSession {
    controller: AbortController | null;
    sessionId: string | undefined;
    channelWorkDir: string;
    channelName?: string;
    messageQueue: QueuedMessage[];
    // deno-lint-ignore no-explicit-any
    mcpServers?: Record<string, any>;
    // Whether this channel has been primed with its PROGRESS.md this process.
    // Falsy after a bot restart (sessions loaded from disk) or a /new, so the
    // next message re-injects the durable progress file as context.
    primed?: boolean;
    // Per-channel provider name (defaults to the global default provider)
    providerName?: string;
    // Per-channel model override (falls back to the global default model).
    // Stored per-channel because a Claude model ID is invalid for Devin and
    // vice-versa, so a single global model would clash across providers.
    modelName?: string;
  }
  const channelSessions = new Map<string, ChannelSession>();
  let activeChannelId: string | undefined;

  // Provider registry — supports multiple AI CLI backends (Claude Code, Devin, etc.)
  const providerRegistry: ProviderRegistry = createProviderRegistry();
  const defaultProviderName = getDefaultProviderName();
  console.log(`[Providers] Default provider: ${defaultProviderName}`);

  // Global cap on concurrent AI sessions across ALL channels. Each
  // running session's process tree can hold several hundred MB, so unbounded
  // cross-channel concurrency is the main driver of host memory-pressure
  // lockups. This counting semaphore gates how many onClaude() calls run at
  // once; a channel that can't get a slot waits (it stays "busy", so further
  // messages to it queue per-channel as usual). Tune via MAX_CONCURRENT_CLAUDE.
  const MAX_CONCURRENT_CLAUDE = Math.max(1, Number(Deno.env.get("MAX_CONCURRENT_CLAUDE") ?? "1"));
  let claudeSlots = MAX_CONCURRENT_CLAUDE;
  const claudeWaiters: Array<() => void> = [];
  function acquireClaudeSlot(): Promise<void> {
    if (claudeSlots > 0) {
      claudeSlots--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => claudeWaiters.push(resolve));
  }
  function releaseClaudeSlot(): void {
    // Hand the freed slot directly to the next waiter (no increment) so the
    // count can never exceed the cap; only bump the pool when nobody's waiting.
    const next = claudeWaiters.shift();
    if (next) next();
    else claudeSlots++;
  }

  // Session persistence file path
  const sessionStatePath = `${workDir}/.claude-sessions.json`;

  async function saveSessionState(): Promise<void> {
    try {
      const state: Record<string, { sessionId?: string; channelName?: string; providerName?: string; modelName?: string }> = {};
      for (const [channelId, session] of channelSessions) {
        if (session.sessionId) {
          state[channelId] = {
            sessionId: session.sessionId,
            channelName: session.channelName,
            providerName: session.providerName,
            modelName: session.modelName,
          };
        }
      }
      await Deno.writeTextFile(sessionStatePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.warn('Could not save session state:', error instanceof Error ? error.message : String(error));
    }
  }

  async function loadSessionState(): Promise<void> {
    try {
      const content = await Deno.readTextFile(sessionStatePath);
      const state: Record<string, { sessionId?: string; channelName?: string; providerName?: string; modelName?: string }> = JSON.parse(content);
      for (const [channelId, saved] of Object.entries(state)) {
        if (saved.sessionId) {
          const folderName = saved.channelName || channelId;
          channelSessions.set(channelId, {
            controller: null,
            sessionId: saved.sessionId,
            channelWorkDir: `${workDir}/${folderName}`,
            channelName: saved.channelName,
            messageQueue: [],
            providerName: saved.providerName,
            modelName: saved.modelName,
          });
          console.log(`Restored session for channel ${folderName}: ${saved.sessionId}`);
        }
      }
    } catch {
      // No saved state or parse error — start fresh
    }
  }

  // Load persisted sessions from disk
  await loadSessionState();

  function getChannelSession(channelId: string, channelName?: string): ChannelSession {
    if (!channelSessions.has(channelId)) {
      const folderName = channelName || channelId;
      channelSessions.set(channelId, {
        controller: null,
        sessionId: undefined,
        channelWorkDir: `${workDir}/${folderName}`,
        channelName: folderName,
        messageQueue: [],
      });
    } else if (channelName && channelName !== channelId) {
      // If session was restored with ID as name (fallback), correct it now that we have the real name
      const session = channelSessions.get(channelId)!;
      if (session.channelName === channelId) {
        session.channelName = channelName;
        session.channelWorkDir = `${workDir}/${channelName}`;
        console.log(`[Session] Corrected channel ${channelId} workDir to ${session.channelWorkDir}`);
      }
    }
    return channelSessions.get(channelId)!;
  }

  // Dynamic workDir getter for Claude handlers — returns the active channel's folder
  function getClaudeWorkDir(): string {
    if (activeChannelId) {
      const session = channelSessions.get(activeChannelId);
      if (session) return session.channelWorkDir;
    }
    return workDir;
  }
  
  // Message history for navigation
  const messageHistoryOps: MessageHistoryOps = createMessageHistory(50);
  
  // Create all managers using bot-factory
  const managers: BotManagers = createBotManagers({
    config: {
      discordToken,
      applicationId,
      workDir,
      categoryName: actualCategoryName,
      userId: defaultMentionUserId,
    },
    crashHandlerOptions: {
      maxRetries: 3,
      retryDelay: 5000,
      enableAutoRestart: true,
      logCrashes: true,
      notifyOnCrash: true,
      // deno-lint-ignore require-await
      onCrashNotification: async (report) => {
        console.warn(`Process crash: ${report.processType} ${report.processId || ''} - ${report.error.message}`);
      },
    },
  });
  
  const { shellManager, worktreeBotManager, crashHandler, healthMonitor, claudeSessionManager } = managers;
  
  // Setup periodic cleanup tasks
  const cleanupInterval = setupPeriodicCleanup(managers, 3600000, [cleanupPaginationStates]);
  
  // Initialize bot settings
  const settingsOps = createBotSettings(defaultMentionUserId, DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS);
  const currentSettings = settingsOps.getSettings();
  const botSettings = currentSettings.legacy;
  
  // Bot instance placeholder
  // deno-lint-ignore no-explicit-any prefer-const
  let bot: any;
  let claudeSender: ((messages: ClaudeMessage[]) => Promise<void>) | null = null;
  
  // Create sendClaudeMessages function that uses the sender when available
  const sendClaudeMessages = async (messages: ClaudeMessage[]) => {
    if (claudeSender) {
      await claudeSender(messages);
    }
  };

  // Create all handlers using the registry (centralized handler creation)
  const allHandlers: AllHandlers = createAllHandlers(
    {
      workDir,
      getClaudeWorkDir,
      repoName,
      branchName,
      categoryName: actualCategoryName,
      discordToken,
      applicationId,
      defaultMentionUserId,
      shellManager,
      worktreeBotManager,
      crashHandler,
      healthMonitor,
      claudeSessionManager,
      sendClaudeMessages,
      onBotSettingsUpdate: (settings) => {
        botSettings.mentionEnabled = settings.mentionEnabled;
        botSettings.mentionUserId = settings.mentionUserId;
        if (bot) {
          bot.updateBotSettings(settings);
        }
      },
      getChannelModel: () => activeChannelId ? getChannelSession(activeChannelId).modelName : undefined,
    },
    {
      getController: () => activeChannelId ? getChannelSession(activeChannelId).controller : null,
      setController: (controller) => { if (activeChannelId) getChannelSession(activeChannelId).controller = controller; },
      getSessionId: () => activeChannelId ? getChannelSession(activeChannelId).sessionId : undefined,
      setSessionId: (sessionId) => { if (activeChannelId) { getChannelSession(activeChannelId).sessionId = sessionId; saveSessionState(); } },
    },
    settingsOps
  );

  // Create command handlers using the wrapper factory
  const handlers: CommandHandlers = createAllCommandHandlers({
    handlers: allHandlers,
    messageHistory: messageHistoryOps,
    getClaudeController: () => activeChannelId ? getChannelSession(activeChannelId).controller : null,
    getClaudeSessionId: () => activeChannelId ? getChannelSession(activeChannelId).sessionId : undefined,
    setClaudeSessionId: (id) => { if (activeChannelId) { const s = getChannelSession(activeChannelId); s.sessionId = id; if (!id) s.primed = false; saveSessionState(); } },
    setActiveChannelId: (channelId) => { activeChannelId = channelId; },
    clearChannelQueue: () => {
      if (activeChannelId) {
        const session = channelSessions.get(activeChannelId);
        if (session && session.messageQueue.length > 0) {
          const count = session.messageQueue.length;
          session.messageQueue.length = 0;
          return count;
        }
      }
      return 0;
    },
    getClaudeWorkDir,
    crashHandler,
    healthMonitor,
    botSettings,
    getChannelMcpServers: () => activeChannelId ? getChannelSession(activeChannelId).mcpServers : undefined,
    setChannelMcpServers: (servers) => { if (activeChannelId) getChannelSession(activeChannelId).mcpServers = servers; },
    cleanupInterval,
    getChannelProvider: () => activeChannelId ? getChannelSession(activeChannelId).providerName : undefined,
    setChannelProvider: (name) => { if (activeChannelId) { getChannelSession(activeChannelId).providerName = name; saveSessionState(); } },
    getDefaultProviderName: () => defaultProviderName,
    getAvailableProviderNames: () => {
      const names: string[] = [];
      // Synchronous check — returns all registered provider names
      // (isAvailable() is async, so we return all and let /provider list handle availability)
      for (const name of ["claude-code", "devin"]) {
        if (providerRegistry.hasProvider(name)) names.push(name);
      }
      return names;
    },
    getChannelModel: () => activeChannelId ? getChannelSession(activeChannelId).modelName : undefined,
    setChannelModel: (model) => { if (activeChannelId) { getChannelSession(activeChannelId).modelName = model; saveSessionState(); } },
    getGlobalDefaultModel: () => settingsOps.getSettings().unified.defaultModel,
    getProvider: (name) => providerRegistry.hasProvider(name) ? providerRegistry.getProvider(name) : undefined,
  });

  // Create button handlers (expand/collapse for truncated content)
  const buttonHandlers: ButtonHandlers = createButtonHandlers(
    {},
    expandableContent
  );
  const expandHandler = createExpandButtonHandler(expandableContent);

  // Create dependencies object for Discord bot
  const dependencies: BotDependencies = {
    commands: getAllCommands(),
    cleanSessionId,
    botSettings
  };

  // Message handler: relay all messages to Claude (per-channel sessions)
  const onMessage = async (ctx: InteractionContext, messageContent: string, channelId: string, channelName: string, imageUrls?: string[], fileAttachments?: Array<{ url: string; name: string }>) => {
    // Set active channel so session state closures reference the right channel
    activeChannelId = channelId;

    const session = getChannelSession(channelId, channelName);

    // Ensure the channel's folder exists
    try {
      await Deno.mkdir(session.channelWorkDir, { recursive: true });
    } catch {
      // Already exists, ignore
    }

    // Build prompt with image attachments (resized to max 1500px)
    let prompt = messageContent;
    if (imageUrls && imageUrls.length > 0) {
      const downloadedPaths: string[] = [];
      for (const url of imageUrls) {
        try {
          const filename = `image-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.png`;
          const filePath = `${session.channelWorkDir}/${filename}`;
          const response = await fetch(url);
          const arrayBuffer = await response.arrayBuffer();
          await Deno.writeFile(filePath, new Uint8Array(arrayBuffer));

          // Resize image to max 1500px (largest dimension) to stay under API limits
          try {
            const cmd = Deno.build.os === "darwin"
              ? new Deno.Command("sips", { args: ["--resampleLargest", "1500", filePath], stdout: "null", stderr: "piped" })
              : new Deno.Command("convert", { args: [filePath, "-resize", "1500x1500>", filePath], stdout: "null", stderr: "piped" });
            const result = await cmd.output();
            if (!result.success) {
              console.warn(`Image resize warning: ${new TextDecoder().decode(result.stderr)}`);
            }
          } catch {
            console.warn(`Could not resize image (install ImageMagick on Linux), using original`);
          }

          downloadedPaths.push(filePath);
          console.log(`Downloaded image to: ${filePath}`);
        } catch (error) {
          console.error('Failed to download image:', error);
        }
      }
      if (downloadedPaths.length > 0) {
        const imageRefs = downloadedPaths.map(p => `[Attached image: ${p}]`).join('\n');
        prompt = prompt ? `${prompt}\n\n${imageRefs}` : `Please look at this image and describe what you see.\n\n${imageRefs}`;
      }
    }

    // Download non-image file attachments to the channel's working directory
    if (fileAttachments && fileAttachments.length > 0) {
      const savedFiles: string[] = [];
      for (const file of fileAttachments) {
        try {
          const filePath = `${session.channelWorkDir}/${file.name}`;
          const response = await fetch(file.url);
          const arrayBuffer = await response.arrayBuffer();
          await Deno.writeFile(filePath, new Uint8Array(arrayBuffer));
          savedFiles.push(filePath);
          console.log(`Downloaded file to: ${filePath}`);
        } catch (error) {
          console.error('Failed to download file:', error);
        }
      }
      if (savedFiles.length > 0) {
        const fileRefs = savedFiles.map(p => `[Attached file: ${p}]`).join('\n');
        prompt = prompt ? `${prompt}\n\n${fileRefs}` : `I've attached some files for you to work with.\n\n${fileRefs}`;
      }
    }

    // If Claude is busy in this channel, queue the message
    if (session.controller && !session.controller.signal.aborted) {
      session.messageQueue.push({ ctx, prompt });
      const pos = session.messageQueue.length;
      await ctx.reply({
        embeds: [{
          color: 0x9b59b6,
          title: "Queued",
          description: `Your message has been queued (position ${pos}). It will be processed when the current task finishes.`,
        }],
      });
      return;
    }

    await processMessage(channelId, session, ctx, prompt);
  };

  // Restore durable per-channel context from PROGRESS.md so a fresh Claude
  // session can resume after a bot restart (or a /new) even when CLI session
  // resume is unavailable. Runs once per channel per process; Claude is asked
  // to keep PROGRESS.md updated via appendSystemPrompt (see claude/client.ts).
  async function primeFromProgressFile(session: ChannelSession, prompt: string): Promise<string> {
    if (session.primed) return prompt;
    session.primed = true;
    try {
      const progressPath = `${session.channelWorkDir}/PROGRESS.md`;
      const progress = (await Deno.readTextFile(progressPath)).trim();
      if (progress.length === 0) return prompt;
      // Cap injected context; keep the most recent tail if oversized.
      const MAX_CHARS = 8000;
      const body = progress.length > MAX_CHARS ? `...(truncated)...\n${progress.slice(-MAX_CHARS)}` : progress;
      console.log(`[Prime] Restored PROGRESS.md context for #${session.channelName} (${progress.length} chars)`);
      return `[Context restored from PROGRESS.md — the running progress log for this channel, ` +
        `written by a previous session. Use it to continue where the last session left off and ` +
        `avoid redoing completed work. Keep PROGRESS.md updated as you go.]\n\n` +
        `${body}\n\n---\n\n${prompt}`;
    } catch {
      // No progress file yet — nothing to restore.
      return prompt;
    }
  }

  // ================================
  // Vision Bridge for non-Claude providers
  // ================================

  /**
   * When a non-Claude provider (e.g. Devin) receives a prompt with image
   * attachments, it can't see the images — only the text prompt. This
   * function detects `[Attached image: /path]` references in the prompt,
   * uses `claude -p` (which has vision via the Claude Code CLI) to describe
   * each image, and replaces the references with rich text descriptions.
   *
   * For Claude Code, this is a no-op — Claude can read the files directly.
   */
  async function describeImagesForProvider(prompt: string, providerName: string): Promise<string> {
    // Claude Code can read image files from disk directly — no bridge needed.
    if (providerName === "claude-code") return prompt;

    // Find all [Attached image: /path] references
    const imagePattern = /\[Attached image: ([^\]]+)\]/g;
    const matches = [...prompt.matchAll(imagePattern)];
    if (matches.length === 0) return prompt;

    console.log(`[Vision Bridge] Describing ${matches.length} image(s) via claude -p for provider "${providerName}"`);

    const claudePath = Deno.env.get("CLAUDE_PATH") || "claude";
    let modifiedPrompt = prompt;

    for (const match of matches) {
      const fullRef = match[0];
      const imagePath = match[1].trim();

      try {
        // Use claude -p in print mode with a vision-capable model to describe
        // the image. Haiku is fast and cheap for simple image description.
        const describeCmd = new Deno.Command(claudePath, {
          args: [
            "-p",
            "--model", "claude-haiku-4-5",
            "--output-format", "text",
            `Look at the image at ${imagePath} and provide a detailed description. Include: what the image shows, any text visible in the image, layout/structure if it's a screenshot or diagram, colors, and any notable details. Be thorough but concise.`,
          ],
          stdout: "piped",
          stderr: "piped",
        });

        console.log(`[Vision Bridge] Describing: ${imagePath}`);
        const { success, stdout, stderr } = await describeCmd.output();

        if (success) {
          const description = new TextDecoder().decode(stdout).trim();
          if (description) {
            const replacement = `[Attached image: ${imagePath}]\n[Image description: ${description}]`;
            modifiedPrompt = modifiedPrompt.replace(fullRef, replacement);
            console.log(`[Vision Bridge] Got description (${description.length} chars) for ${imagePath}`);
            continue;
          }
        }

        // If claude failed, log and leave the original reference
        const stderrText = new TextDecoder().decode(stderr).trim();
        console.warn(`[Vision Bridge] claude -p failed for ${imagePath}: ${stderrText.substring(0, 200)}`);
      } catch (error) {
        console.warn(`[Vision Bridge] Error describing ${imagePath}:`, error instanceof Error ? error.message : String(error));
      }
    }

    return modifiedPrompt;
  }

  // Process a single message (and drain the queue after)
  async function processMessage(channelId: string, session: ChannelSession, ctx: InteractionContext, prompt: string) {
    messageHistoryOps.addToHistory(prompt);

    // On the first message since this process started (covers restarts) or the
    // first after a /new, prepend the channel's saved progress as context.
    prompt = await primeFromProgressFile(session, prompt);

    // Create a per-channel controller so channels don't block each other
    if (session.controller) {
      session.controller.abort();
    }
    const controller = new AbortController();
    session.controller = controller;

    // Create a per-channel sender so output always goes to the correct channel
    const channelSendFn = createClaudeSender(
      createDiscordSenderAdapter(() => bot.getChannelById(channelId))
    );

    // Wait for a global slot before starting the heavy AI session, so the
    // host never runs more than MAX_CONCURRENT_CLAUDE at once. The channel is
    // already marked busy (controller set above), so its own messages queue.
    await acquireClaudeSlot();
    try {
      const providerName = session.providerName || defaultProviderName;
      const provider = providerRegistry.getProvider(providerName);

      if (provider.name === "claude-code") {
        // Claude Code uses the existing onClaude handler which wraps sendToClaudeCode
        // with full streaming JSON support, sub-agent heartbeats, etc.
        const result = await allHandlers.claude.onClaude(ctx, prompt, session.sessionId || undefined, channelSendFn, controller, session.mcpServers);
        session.sessionId = result.sessionId;
      } else {
        // Generic provider path — uses provider.sendPrompt() with onMessage callback

        // Vision bridge: non-Claude providers can't see images. Use claude -p
        // to describe any attached images and inject the text descriptions.
        prompt = await describeImagesForProvider(prompt, provider.name);

        await ctx.reply({
          embeds: [{
            color: 0xffff00,
            title: `${provider.displayName} Running...`,
            description: 'Waiting for response...',
            timestamp: true,
          }],
        });

        const result = await provider.sendPrompt({
          workDir: session.channelWorkDir,
          prompt,
          controller,
          sessionId: session.sessionId || undefined,
          onMessage: (msg: ClaudeMessage) => {
            channelSendFn([msg]).catch((err) => {
              console.error(`[Provider ${provider.name} sender error]:`, err instanceof Error ? err.message : String(err));
            });
          },
          onStreamJson: provider.name === "claude-code" ? (jsonData) => {
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              channelSendFn(claudeMessages).catch((err) => {
                console.error(`[Provider ${provider.name} stream error]:`, err instanceof Error ? err.message : String(err));
              });
            }
          } : undefined,
          // The unified defaultModel is a Claude Code model ID (e.g.
          // "claude-opus-4-8") and is not valid for other providers like Devin.
          // Only apply it for the claude-code provider; other providers use the
          // per-channel override (session.modelName) or let the provider choose.
          modelOptions: (() => {
            const effectiveModel = session.modelName ||
              (provider.name === "claude-code" ? settingsOps.getSettings().unified.defaultModel : undefined);
            return effectiveModel ? { model: effectiveModel } : undefined;
          })(),
          workspaceRootDir: workDir,
          mcpServers: session.mcpServers,
        });

        session.sessionId = result.sessionId;

        // Send completion message
        await channelSendFn([{
          type: 'system',
          content: '',
          metadata: {
            subtype: 'completion',
            session_id: result.sessionId,
            model: result.modelUsed || 'Default',
            total_cost_usd: result.cost,
            duration_ms: result.duration,
            cwd: session.channelWorkDir,
          },
        }]).catch(() => {});
      }

      saveSessionState();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[processMessage] Unhandled error in channel ${channelId}:`, errMsg);
      // Surface the error in Discord so the user isn't left staring at a
      // "Running..." embed with no follow-up.
      await ctx.reply({
        embeds: [{
          color: 0xff0000,
          title: 'Error',
          description: `\`\`\`\n${errMsg.substring(0, 1900)}\n\`\`\``,
          timestamp: true,
        }],
      }).catch(() => {});
    } finally {
      // ALWAYS clear the controller so the channel doesn't stay "busy" forever,
      // and release the global slot for the next waiting channel.
      session.controller = null;
      releaseClaudeSlot();
    }

    // Process next queued message if any
    const next = session.messageQueue.shift();
    if (next) {
      activeChannelId = channelId;
      await processMessage(channelId, session, next.ctx, next.prompt);
    }
  }

  // Create Discord bot
  bot = await createDiscordBot(config, handlers, buttonHandlers, dependencies, crashHandler, onMessage, expandHandler);
  
  // Create Discord sender for Claude messages (fallback — uses bot's global active channel)
  claudeSender = createClaudeSender(createDiscordSenderAdapter(() => bot.getChannel()));

  // ================================
  // Scheduled Jobs
  // ================================

  const scheduledJobsEnv = Deno.env.get("SCHEDULED_JOBS");
  if (scheduledJobsEnv) {
    const { ChannelType } = await import("npm:discord.js@14.14.1");

    interface ScheduledJob {
      channelName: string;
      cron: string;
      staggerMinutes: number; // 0 = no stagger, >0 = random delay up to N minutes
      prompt: string;
    }

    // Parse jobs from env: channel|cron|prompt OR channel|cron|~60|prompt
    // The optional ~N field adds a random 0-N minute stagger before firing
    const scheduledJobs: ScheduledJob[] = scheduledJobsEnv.split(';').map(entry => {
      const parts = entry.trim().split('|');
      if (parts.length < 3) return null;
      const channelName = parts[0].trim();
      const cron = parts[1].trim();
      // Check if 3rd field is a stagger value (~N)
      const maybeStagger = parts[2].trim();
      const staggerMatch = maybeStagger.match(/^~(\d+)$/);
      if (staggerMatch) {
        if (parts.length < 4) return null; // Need at least channel|cron|~N|prompt
        return {
          channelName,
          cron,
          staggerMinutes: parseInt(staggerMatch[1], 10),
          prompt: parts.slice(3).join('|').trim(),
        };
      }
      return {
        channelName,
        cron,
        staggerMinutes: 0,
        prompt: parts.slice(2).join('|').trim(),
      };
    }).filter((j): j is ScheduledJob => j !== null);

    if (scheduledJobs.length > 0) {
      console.log(`Scheduled jobs loaded: ${scheduledJobs.map(j => `#${j.channelName} (${j.cron}${j.staggerMinutes ? ` ~${j.staggerMinutes}m` : ''})`).join(', ')}`);

      // Simple cron field matcher (supports *, ranges like 1-5, and lists like 1,3,5)
      const matchField = (field: string, value: number): boolean => {
        if (field === '*') return true;
        return field.split(',').some(part => {
          if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            return value >= start && value <= end;
          }
          return Number(part) === value;
        });
      };

      const matchesCron = (cron: string, now: Date): boolean => {
        const parts = cron.split(/\s+/);
        if (parts.length < 5) return false;
        const [minute, hour, dom, month, dow] = parts;
        return matchField(minute, now.getMinutes())
            && matchField(hour, now.getHours())
            && matchField(dom, now.getDate())
            && matchField(month, now.getMonth() + 1)
            && matchField(dow, now.getDay());
      };

      // Create a synthetic InteractionContext for a channel (no real user interaction)
      // deno-lint-ignore no-explicit-any
      const createScheduledContext = (channel: any): InteractionContext => ({
        channelId: channel.id,
        async deferReply() { await channel.sendTyping(); },
        async editReply(content: MessageContent) { await channel.send(convertMessageContent(content)); },
        async followUp(content: MessageContent) { await channel.send(convertMessageContent(content)); },
        async reply(content: MessageContent) { await channel.send(convertMessageContent(content)); },
        async update(content: MessageContent) { await channel.send(convertMessageContent(content)); },
        getString() { return null; },
        getInteger() { return null; },
        getBoolean() { return null; },
      });

      const lastRunTimes = new Map<string, number>();
      const pendingDelays = new Set<string>(); // Track jobs waiting on stagger delay

      const runJob = (job: ScheduledJob) => {
        const guild = bot.client.guilds.cache.first();
        // deno-lint-ignore no-explicit-any
        const channel = guild?.channels.cache.find((c: any) =>
          c.type === ChannelType.GuildText && c.name === job.channelName
        );
        if (!channel) {
          console.warn(`[Scheduler] Channel #${job.channelName} not found`);
          return;
        }
        console.log(`[Scheduler] Running job in #${job.channelName} at ${new Date().toLocaleTimeString()}`);
        const ctx = createScheduledContext(channel);
        onMessage(ctx, job.prompt, channel.id, job.channelName).catch(err => {
          console.error(`[Scheduler] Error running job in #${job.channelName}:`, err instanceof Error ? err.message : String(err));
        });
      };

      setInterval(() => {
        const now = new Date();
        for (const job of scheduledJobs) {
          if (!matchesCron(job.cron, now)) continue;

          const key = `${job.channelName}:${job.cron}`;
          const lastRun = lastRunTimes.get(key) || 0;
          if (now.getTime() - lastRun < 120_000) continue; // Prevent double-fire
          if (pendingDelays.has(key)) continue; // Already waiting on stagger
          lastRunTimes.set(key, now.getTime());

          if (job.staggerMinutes > 0) {
            // Random stagger: delay 0-N minutes to emulate a human starting their day
            const staggerMs = Math.floor(Math.random() * job.staggerMinutes * 60 * 1000);
            const staggerMin = Math.floor(staggerMs / 60000);
            console.log(`[Scheduler] Job #${job.channelName} matched — staggering by ${staggerMin}m (will run at ~${new Date(now.getTime() + staggerMs).toLocaleTimeString()})`);
            pendingDelays.add(key);
            setTimeout(() => {
              pendingDelays.delete(key);
              runJob(job);
            }, staggerMs);
          } else {
            runJob(job);
          }
        }
      }, 60_000);
    }
  }

  // ================================
  // Slack agent (optional — rfpbids proposal edits + email drafts)
  // ================================
  // Additive + fully gated: no-ops unless SLACK_APP_TOKEN + SLACK_AGENT_BOT_TOKEN
  // are set, so the Discord path is unaffected. Runs a separate `rfpbids-agent`
  // Slack app in Socket Mode; never blocks or crashes bot startup.
  try {
    const { startSlackAgent } = await import("./slack/agent.ts");
    startSlackAgent({ workDir }).catch((err) =>
      console.error("[slack-agent] failed to start:", err instanceof Error ? err.message : String(err))
    );
  } catch (err) {
    console.error("[slack-agent] import failed:", err instanceof Error ? err.message : String(err));
  }

  // Setup signal handlers for graceful shutdown
  setupSignalHandlers({
    managers,
    allHandlers,
    getClaudeController: () => {
      // Return any active controller from any channel
      for (const session of channelSessions.values()) {
        if (session.controller && !session.controller.signal.aborted) return session.controller;
      }
      return null;
    },
    abortAllSessions: () => {
      for (const session of channelSessions.values()) {
        if (session.controller) session.controller.abort();
      }
    },
    claudeSender,
    actualCategoryName,
    repoName,
    branchName,
    cleanupInterval,
    // deno-lint-ignore no-explicit-any
    bot: bot as any,
  });
  
  return bot;
}

// ================================
// Helper Functions
// ================================

/**
 * Create Discord sender adapter that routes to a specific channel.
 * @param getChannel - Function that returns the target TextChannel (or null)
 */
// deno-lint-ignore no-explicit-any
function createDiscordSenderAdapter(getChannel: () => any): DiscordSender {
  return {
    async sendMessage(content) {
      const channel = getChannel();
      if (!channel) {
        console.error('[Sender] No channel found — output dropped');
        return;
      }

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("npm:discord.js@14.14.1");

      // deno-lint-ignore no-explicit-any
      const payload: any = {};

      if (content.content) payload.content = content.content;

      if (content.embeds) {
        payload.embeds = content.embeds.map(e => {
          const embed = new EmbedBuilder();
          if (e.color !== undefined) embed.setColor(e.color);
          if (e.title) embed.setTitle(e.title);
          if (e.description) embed.setDescription(e.description);
          if (e.fields) e.fields.forEach(f => embed.addFields(f));
          if (e.footer) embed.setFooter(e.footer);
          if (e.timestamp) embed.setTimestamp();
          return embed;
        });
      }

      if (content.components) {
        payload.components = content.components.map(row => {
          // deno-lint-ignore no-explicit-any
          const actionRow = new ActionRowBuilder<any>();
          row.components.forEach(comp => {
            const button = new ButtonBuilder()
              .setCustomId(comp.customId)
              .setLabel(comp.label);

            switch (comp.style) {
              case 'primary': button.setStyle(ButtonStyle.Primary); break;
              case 'secondary': button.setStyle(ButtonStyle.Secondary); break;
              case 'success': button.setStyle(ButtonStyle.Success); break;
              case 'danger': button.setStyle(ButtonStyle.Danger); break;
              case 'link': button.setStyle(ButtonStyle.Link); break;
            }

            actionRow.addComponents(button);
          });
          return actionRow;
        });
      }

      if (content.files && content.files.length > 0) {
        const { AttachmentBuilder } = await import("npm:discord.js@14.14.1");
        payload.files = content.files.map(f => new AttachmentBuilder(f.path, { name: f.name }));
      }

      await channel.send(payload);
    }
  };
}

/**
 * Setup signal handlers for graceful shutdown.
 */
function setupSignalHandlers(ctx: {
  managers: BotManagers;
  allHandlers: AllHandlers;
  getClaudeController: () => AbortController | null;
  abortAllSessions?: () => void;
  claudeSender: ((messages: ClaudeMessage[]) => Promise<void>) | null;
  actualCategoryName: string;
  repoName: string;
  branchName: string;
  cleanupInterval: number;
  // deno-lint-ignore no-explicit-any
  bot: any;
}) {
  const { managers, allHandlers, getClaudeController, abortAllSessions, claudeSender, actualCategoryName, repoName, branchName, cleanupInterval, bot } = ctx;
  const { crashHandler, healthMonitor } = managers;
  const { shell: shellHandlers, git: gitHandlers } = allHandlers;
  
  const handleSignal = async (signal: string) => {
    console.log(`\n${signal} signal received. Stopping bot...`);
    
    try {
      // Stop all processes
      shellHandlers.killAllProcesses();
      gitHandlers.killAllWorktreeBots();
      
      // Cancel all AI sessions
      if (abortAllSessions) {
        abortAllSessions();
      } else {
        const claudeController = getClaudeController();
        if (claudeController) {
          claudeController.abort();
        }
      }
      
      // Shutdown notification intentionally suppressed — the bot's crash-backoff
      // restart loop fired a red "Shutdown SIGTERM" embed on every restart, which
      // was just channel noise. (Completion/cost embeds are still sent.)

      // Cleanup
      healthMonitor.stopAll();
      crashHandler.cleanup();
      cleanupPaginationStates();
      clearInterval(cleanupInterval);
      
      setTimeout(() => {
        bot.client.destroy();
        Deno.exit(0);
      }, 1000);
    } catch (error) {
      console.error('Error during shutdown:', error);
      Deno.exit(1);
    }
  };
  
  // Cross-platform signal handling
  const platform = Deno.build.os;
  
  try {
    Deno.addSignalListener("SIGINT", () => handleSignal("SIGINT"));
    
    if (platform === "windows") {
      try {
        Deno.addSignalListener("SIGBREAK", () => handleSignal("SIGBREAK"));
      } catch (winError) {
        const message = winError instanceof Error ? winError.message : String(winError);
        console.warn('Could not register SIGBREAK handler:', message);
      }
    } else {
      try {
        Deno.addSignalListener("SIGTERM", () => handleSignal("SIGTERM"));
      } catch (unixError) {
        const message = unixError instanceof Error ? unixError.message : String(unixError);
        console.warn('Could not register SIGTERM handler:', message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Signal handler registration error:', message);
  }
}

// ================================
// .env Auto-Load
// ================================

/**
 * Load environment variables from .env file if it exists.
 * This enables zero-config startup when .env is present.
 */
async function loadEnvFile(): Promise<void> {
  try {
    const envPath = `${Deno.cwd()}/.env`;
    const stat = await Deno.stat(envPath).catch(() => null);
    
    if (!stat?.isFile) return;
    
    const content = await Deno.readTextFile(envPath);
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // Parse KEY=VALUE format
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      
      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();
      
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // Only set if not already defined (env vars take precedence)
      if (!Deno.env.get(key) && key && value) {
        Deno.env.set(key, value);
      }
    }
    
    console.log('✓ Loaded configuration from .env file');
  } catch (error) {
    // Silently ignore .env loading errors
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Note: Could not load .env file: ${message}`);
  }
}

// ================================
// Main Execution
// ================================

if (import.meta.main) {
  try {
    // Auto-load .env file (if present)
    await loadEnvFile();
    
    // Get environment variables and command line arguments
    const discordToken = Deno.env.get("DISCORD_TOKEN");
    const applicationId = Deno.env.get("APPLICATION_ID");
    const envCategoryName = Deno.env.get("CATEGORY_NAME");
    const envMentionUserId = Deno.env.get("USER_ID") || Deno.env.get("DEFAULT_MENTION_USER_ID");
    const envWorkDir = Deno.env.get("WORK_DIR");
    
    if (!discordToken || !applicationId) {
      console.error("╔═══════════════════════════════════════════════════════════╗");
      console.error("║  Error: Missing required configuration                    ║");
      console.error("╠═══════════════════════════════════════════════════════════╣");
      console.error("║  DISCORD_TOKEN and APPLICATION_ID are required.           ║");
      console.error("║                                                           ║");
      console.error("║  Options:                                                 ║");
      console.error("║  1. Create a .env file with these variables               ║");
      console.error("║  2. Set environment variables before running              ║");
      console.error("║  3. Run setup script: ./setup.sh or .\\setup.ps1          ║");
      console.error("╚═══════════════════════════════════════════════════════════╝");
      Deno.exit(1);
    }
    
    // Parse command line arguments
    const args = parseArgs(Deno.args);
    const categoryName = args.category || envCategoryName;
    const defaultMentionUserId = args.userId || envMentionUserId;
    const workDir = envWorkDir || `${Deno.cwd()}/workspace`;
    
    // Get Git information
    const gitInfo = await getGitInfo();
    
    // Create and start bot
    await createClaudeCodeBot({
      discordToken,
      applicationId,
      workDir,
      repoName: gitInfo.repo,
      branchName: gitInfo.branch,
      categoryName,
      defaultMentionUserId,
    });
    
    console.log("✓ Bot has started. Press Ctrl+C to stop.");
  } catch (error) {
    console.error("Failed to start bot:", error);
    Deno.exit(1);
  }
}
