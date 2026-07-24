# CLAUDE.md

## Project Overview

Discord bot that provides a conversational interface to AI coding agents. Users type messages in Discord channels which are relayed to AI sessions (Claude Code or Devin CLI) running on the host machine.

## Runtime & Commands

- **Runtime:** Deno (not Node.js)
- **Start:** `deno task start`
- **Dev (hot reload):** `deno task dev`
- **Type check:** `deno check index.ts`
- **Test Devin provider:** `deno run --allow-all providers/devin_test.ts` (exercises sendPrompt end-to-end against the real Devin CLI — no Discord needed)

## Important Rules

- **NEVER start the bot** (`deno task start`) from within an AI session — this would create a recursive loop since the bot itself runs AI CLI sessions.
- Always run `deno check index.ts` after making changes to verify types.

## Architecture

```
index.ts                   — Entry point, per-channel session state, message queuing, image handling, provider routing
discord/bot.ts             — Discord.js client, message listener, slash command routing
claude/command.ts          — Claude Code handlers (onClaude, onContinue, onClaudeCancel)
claude/client.ts           — SDK wrapper for @anthropic-ai/claude-code (query function)
claude/discord-sender.ts   — Formats Claude stream output as Discord embeds
claude/message-converter.ts — Converts SDK stream JSON into typed ClaudeMessage objects
providers/types.ts         — AIProvider interface, PromptOptions, ProviderResult
providers/registry.ts      — Provider registry (createProviderRegistry, getDefaultProviderName)
providers/claude-code.ts   — Claude Code adapter (wraps sendToClaudeCode)
providers/devin.ts         — Devin CLI adapter (shells out to `devin -p`)
core/command-wrappers.ts   — Slash command handlers (/new, /cancel, /model, /status, /browser, /provider)
core/handler-registry.ts   — Handler factory, registers all handler modules
core/button-handlers.ts    — Expand/collapse buttons for truncated embed content
```

## Key Concepts

- **Per-channel sessions:** Each Discord channel under the bot's category maps to its own AI session and working directory (`WORK_DIR/channel-name/`).
- **Provider selection:** Each channel can use a different AI provider (Claude Code or Devin CLI). Set via `/provider set name:...` or `DEFAULT_PROVIDER` env var. `/provider list` checks CLI availability.
- **Model selection:** Per-channel model override via `/model model:<id>` (free-text — any ID the provider accepts). `/model` with no argument lists the provider's curated models. Stored per-channel because model IDs are provider-specific.
- **Session persistence:** Session IDs, provider name, and model name are saved to `WORK_DIR/.claude-sessions.json` so they survive bot restarts.
- **Message queuing:** Messages sent while the AI is busy are queued and processed sequentially after the current task finishes.
- **Image support:** Discord image attachments are downloaded, resized (max 1500px via `sips` on macOS / `convert` on Linux), and referenced in the prompt.
- **Streaming output:** AI responses stream to Discord as color-coded embeds (green=text, blue=tool use, cyan=tool result, purple=thinking, orange=edits).
- **Rate limit fallback:** If the primary model hits a rate limit, the bot retries with Claude Sonnet 4 (Claude Code provider only).

## Dependencies

- `discord.js` v14.14.1 — Discord bot framework
- `@anthropic-ai/claude-code` SDK — Programmatic Claude Code API
- Claude Code CLI must be installed at the system level and logged in (`claude /login`)
- (Optional) Devin CLI installed and authenticated (`devin setup`)

## Session State Flow

1. User sends message in Discord channel
2. `discord/bot.ts` extracts text + image URLs, calls `onMessage`
3. `index.ts` downloads/resizes images, builds prompt, checks if busy (queue or process)
4. Provider is selected from `session.providerName` or default; Claude Code uses `claude/command.ts` path, other providers use `provider.sendPrompt()` directly
5. For Claude Code: `claude/command.ts` calls `sendToClaudeCode` with prompt + session ID (for resume)
6. For Devin: `providers/devin.ts` shells out to `devin -p --export <path>` and polls the ATIF export file every 1.5s to stream intermediate steps (tool calls, plan updates, thinking) as ClaudeMessages. Session ID and duration are parsed from the export on completion.
7. Stream chunks are converted to `ClaudeMessage` objects and sent to Discord as embeds
8. On completion, session ID + model + provider are persisted to disk
