# CLAUDE.md

## Project Overview

Discord bot that provides a conversational interface to AI coding agents. Users type messages in Discord channels which are relayed to AI sessions (Claude Code or Devin CLI) running on the host machine.

## Runtime & Commands

- **Runtime:** Deno (not Node.js)
- **Start:** `deno task start`
- **Dev (hot reload):** `deno task dev`
- **Type check:** `deno check index.ts`
- **Test Devin provider:** `deno run --allow-all providers/devin_test.ts` (exercises sendPrompt end-to-end against the real Devin CLI — no Discord needed)
- **Test agy / opencode / codex providers:** `deno run --allow-all providers/cli-providers_test.ts [name ...]` — real CLIs, no Discord. Checks availability, a first turn, session resume, and cancellation. A CLI that isn't installed is skipped, not failed.

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
providers/devin.ts         — Devin CLI adapter (`devin -p`, streams by polling its ATIF export)
providers/agy.ts           — Agency CLI adapter (`agy --print --output-format json`)
providers/opencode.ts      — opencode adapter (`opencode run --format json`, JSONL stream)
providers/codex.ts         — Codex adapter (`codex exec --json`, JSONL stream)
providers/cli-runner.ts    — Shared spawn/line-stream/cancel plumbing for agy, opencode, codex
core/command-wrappers.ts   — Slash command handlers (/new, /cancel, /status, /browser, /provider)
core/handler-registry.ts   — Handler factory, registers all handler modules
core/button-handlers.ts    — Expand/collapse buttons for truncated embed content
```

## Key Concepts

- **Per-channel sessions:** Each Discord channel under the bot's category maps to its own AI session and working directory (`WORK_DIR/channel-name/`). **That folder holds the session's NOTES, not a project** — see "Channel folders" below.
- **Provider selection:** Each channel picks one of five AI CLIs — `claude-code` (alias `claude`), `devin`, `agy`, `opencode`, `codex`. Set via `/provider set name:...` or the `DEFAULT_PROVIDER` env var. `/provider list` checks which CLIs are actually installed. Binaries are resolved from `CLAUDE_PATH` / `DEVIN_PATH` / `AGY_PATH` / `OPENCODE_PATH` / `CODEX_PATH`, defaulting to the bare command name.
- **NO model selection — this is deliberate.** The bot chooses *which CLI* to talk to and nothing else; every provider invokes its CLI with no model flag, so each runs on whatever model that CLI is configured with. Change the model in the CLI's own config (`claude` settings, `~/.codex/config.toml`, opencode/agy/devin config), not from Discord. There is no `/model` command and no per-channel model state. Two internal exceptions remain, both unrelated to the channel's conversation model: the image-description helper in `index.ts` pins `claude-haiku-4-5` (a cheap vision call), and `claude/client.ts` retries with Sonnet 4 on a rate limit.
- **Session persistence:** Session IDs and provider name are saved to `WORK_DIR/.claude-sessions.json` so they survive bot restarts. Every provider returns a resumable session ID (claude: `--resume`, devin: `-r`, agy: `--conversation`, opencode: `--session`, codex: `exec resume`).
- **Message queuing:** Messages sent while the AI is busy are queued and processed sequentially after the current task finishes.
- **Image support:** Discord image attachments are downloaded, resized (max 1500px via `sips` on macOS / `convert` on Linux), and referenced in the prompt.
- **Streaming output:** AI responses stream to Discord as green assistant-text embeds. Tool invocations, tool results, thinking blocks, and most system messages are deliberately dropped in `claude/discord-sender.ts` — the channel carries conversation, not mechanics. The only tool that still renders is a `Read` of an image file, which attaches the image itself.
- **Rate limit fallback:** If the primary model hits a rate limit, the bot retries with Claude Sonnet 4 (Claude Code provider only).

## Channel folders: session notes, not projects

**A channel is a Claude session. Its folder in `workspace/` is that session's
scratchpad — `.md` notes and the odd screenshot. Nothing else.**

The code you are asked about almost always lives somewhere else on disk. The
channel folder is where the session keeps `PROGRESS.md`, research notes,
pasted context and images; you `cd` to the real repo to do the work.

This is a DEPARTURE from how it used to work. Channel folders used to hold the
actual project — a whole checkout inside `workspace/<channel>/` — and two
still do:

- **`workspace/rfpbids/`** is the real rfpbids repo (and `~/nodejs/rfpbids` is
  a symlink INTO it, not the other way round). Jay knows; it moves out later.
  **Do not "fix" this mid-task** — active work runs from that path, including
  systemd units that hardcode it.
- **`workspace/trading-bot/`** is an old-style project folder, same story.

Everything else already follows the new shape: a folder of notes
(`assistant/`, `crawler/`, `unlikely-collaborators/`). New channels get the new
shape automatically — `core/channel-notes.ts` seeds a starter `PROGRESS.md`
on a channel's first message (never overwriting an existing one), so the file
is there to fill in rather than something each session has to remember to
create. Fill it in and leave the code where it lives.

`workspace/rfpbids-cron/` is neither: it holds cron wrapper scripts that `cd`
into the rfpbids repo. Not a channel.

## Where the work usually lives (check here first)

**Most new channels are about `~/nodejs/rfpbids` — "bowerbid".** Before asking
Jay what a request refers to, look there. It's the RFP discovery pipeline + the
bowerbid.com tracker + 40-odd proposal workspaces, and it has its own detailed
`CLAUDE.md` at the repo root plus one in `web/`. Read those, not this file, for
anything about bids, proposals, pilots, the tracker, or the pipeline.

Rough routing for a request in a fresh channel:

| The ask sounds like | Start in |
| --- | --- |
| A specific bid, client, or proposal (often the channel's own name) | `~/nodejs/rfpbids/proposals/<slug>-<year>/` |
| RFP discovery, the tracker, deadlines, bidders, `/bower` | `~/nodejs/rfpbids/` + `web/` |
| A pilot site's code | the per-engagement worktree, not the starter clone — see the rfpbids CLAUDE.md |
| The Discord bot itself (providers, embeds, slash commands) | here, `~/nodejs/claude-code-discord/` |

**Channels are often named after a proposal.** A channel called
`unlikely-collaborators` means `proposals/unlikely-collaborators-2026/`. Check
for a matching workspace directory before assuming the request is abstract.

Why this note lives in THIS file: Claude Code loads `CLAUDE.md` from the
working directory and every parent, and every channel folder is a child of
this repo — so a session running in `workspace/<channel>/` inherits this file
automatically. It is the one place a hint reaches every channel.

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
6b. For agy / opencode / codex: `providers/cli-runner.ts` spawns the CLI and streams stdout line-by-line. opencode and codex emit JSONL that is converted to ClaudeMessages as it arrives; agy buffers a single JSON object and is parsed once at the end. Cancellation kills the child and returns the `"Request was cancelled"` sentinel.
7. Stream chunks are converted to `ClaudeMessage` objects and sent to Discord as embeds
8. On completion, session ID + model + provider are persisted to disk
