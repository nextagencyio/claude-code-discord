# claude-code-discord

A Discord bot that gives you a conversational interface to [Claude Code](https://claude.ai/code). Type messages in Discord channels and they're relayed directly to Claude Code sessions running on your machine.

## How It Works

- Each Discord channel under the bot's category is an **independent Claude Code session** with its own working directory
- Just **type a message** — no slash commands needed for normal interaction
- Sessions **persist across bot restarts** (session IDs saved to disk)
- **Image attachments** are automatically downloaded, resized, and passed to Claude
- Messages sent while Claude is busy are **queued** and processed in order

## Commands

Only 4 slash commands:

| Command | Description |
|---------|-------------|
| `/new` | Clear the session and start fresh in the current channel |
| `/cancel` | Cancel the currently running Claude session |
| `/model` | Switch the Claude model (e.g. `claude-opus-4-6`, `claude-sonnet-4-5-20250929`) |
| `/status` | Show current session info, working directory, and run state |

## Quick Start

### Prerequisites

- [Deno](https://deno.com/) runtime
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) installed and logged in (`claude /login`)
- A Discord bot token and application ID ([setup guide](#discord-bot-setup))
- **Message Content Intent** enabled in the Discord Developer Portal (Bot settings)

### Setup

```bash
git clone https://github.com/nextagencyio/claude-code-discord.git
cd claude-code-discord
cp .env.example .env
# Edit .env with your credentials
deno task start
```

### Configuration (.env file)

```env
# Required
DISCORD_TOKEN=your_bot_token_here
APPLICATION_ID=your_application_id_here

# Optional
USER_ID=your_discord_user_id          # Restrict bot to this user
CATEGORY_NAME=claude-code-discord     # Discord category name for channels
WORK_DIR=/path/to/workspace           # Base working directory (default: current)
```

Each channel under the category gets its own subfolder: `WORK_DIR/channel-name/`

## Features

### Per-Channel Sessions
Each channel operates independently with its own:
- Claude Code session (persisted to `.claude-sessions.json`)
- Working directory (`WORK_DIR/channel-name/`)
- Message queue

### Image Support
Attach images to your Discord messages and Claude will see them. Images are:
- Downloaded to the channel's working directory
- Automatically resized to max 1500px to stay within API limits (uses `sips` on macOS, `convert` on Linux)
- Referenced in the prompt so Claude can read them

> **Linux:** Install ImageMagick for image resizing: `sudo apt install imagemagick`

### Message Queuing
If you send a message while Claude is still processing, it gets queued automatically. Once the current task finishes, queued messages are processed in order.

### Streaming Output
Claude's responses stream to Discord in real-time as embedded messages:
- **Green** — Assistant text responses
- **Blue** — Tool use (with truncated preview + expand button)
- **Cyan** — Tool results (with truncated preview + expand button)
- **Purple** — Thinking blocks
- **Orange** — Edit operations (showing file path, old/new content)

### Rate Limit Fallback
If the primary model hits a rate limit, the bot automatically retries with Claude Sonnet 4.

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a **New Application**
3. Go to **Bot** section:
   - Copy the **Token** (this is your `DISCORD_TOKEN`)
   - Enable **Message Content Intent**
4. Go to **General Information**:
   - Copy the **Application ID**
5. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Use Slash Commands`, `Read Message History`, `Embed Links`, `Manage Channels`
6. Open the generated URL to invite the bot to your server

## Architecture

```
index.ts                  — Entry point, per-channel session management, message queuing
discord/bot.ts            — Discord.js client, message listener, command routing
claude/command.ts         — Claude Code handler (onClaude, onContinue, onClaudeCancel)
claude/client.ts          — SDK wrapper for @anthropic-ai/claude-code
claude/discord-sender.ts  — Formats Claude output as Discord embeds
claude/message-converter.ts — Converts SDK stream JSON to typed messages
core/command-wrappers.ts  — 4 slash command handlers
core/handler-registry.ts  — Handler factory and command registration
core/button-handlers.ts   — Expand/collapse buttons for truncated content
```

## License

MIT
