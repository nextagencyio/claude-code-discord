# CLAUDE.md

## Project Overview

Discord bot that provides a conversational interface to Claude Code. Users type messages in Discord channels which are relayed to Claude Code sessions running on the host machine.

## Runtime & Commands

- **Runtime:** Deno (not Node.js)
- **Start:** `deno task start`
- **Dev (hot reload):** `deno task dev`
- **Type check:** `deno check index.ts`
- **No test suite currently**

## Important Rules

- **NEVER start the bot** (`deno task start`) from within a Claude Code session — this would create a recursive loop since the bot itself runs Claude Code.
- Always run `deno check index.ts` after making changes to verify types.

## Architecture

```
index.ts                   — Entry point, per-channel session state, message queuing, image handling
discord/bot.ts             — Discord.js client, message listener, slash command routing
claude/command.ts          — Claude Code handlers (onClaude, onContinue, onClaudeCancel)
claude/client.ts           — SDK wrapper for @anthropic-ai/claude-code (query function)
claude/discord-sender.ts   — Formats Claude stream output as Discord embeds
claude/message-converter.ts — Converts SDK stream JSON into typed ClaudeMessage objects
core/command-wrappers.ts   — 4 slash command handlers (/new, /cancel, /model, /status)
core/handler-registry.ts   — Handler factory, registers all handler modules
core/button-handlers.ts    — Expand/collapse buttons for truncated embed content
```

## Key Concepts

- **Per-channel sessions:** Each Discord channel under the bot's category maps to its own Claude Code session and working directory (`WORK_DIR/channel-name/`).
- **Session persistence:** Session IDs are saved to `WORK_DIR/.claude-sessions.json` so they survive bot restarts.
- **Message queuing:** Messages sent while Claude is busy are queued and processed sequentially after the current task finishes.
- **Image support:** Discord image attachments are downloaded, resized (max 1500px via `sips` on macOS / `convert` on Linux), and referenced in the prompt.
- **Streaming output:** Claude responses stream to Discord as color-coded embeds (green=text, blue=tool use, cyan=tool result, purple=thinking, orange=edits).
- **Rate limit fallback:** If the primary model hits a rate limit, the bot retries with Claude Sonnet 4.

## Dependencies

- `discord.js` v14.14.1 — Discord bot framework
- `@anthropic-ai/claude-code` SDK — Programmatic Claude Code API
- Claude Code CLI must be installed at the system level and logged in (`claude /login`)

## Session State Flow

1. User sends message in Discord channel
2. `discord/bot.ts` extracts text + image URLs, calls `onMessage`
3. `index.ts` downloads/resizes images, builds prompt, checks if busy (queue or process)
4. `claude/command.ts` calls `sendToClaudeCode` with prompt + session ID (for resume)
5. `claude/client.ts` invokes the SDK `query()` function with `stream-json` output
6. Stream chunks are converted to `ClaudeMessage` objects and sent to Discord as embeds
7. On completion, session ID is persisted to disk
