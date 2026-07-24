# AI Bot

> **WARNING: This is an experimental, personal project. Use at your own risk.**
>
> This bot runs AI coding sessions on your machine with broad system access (shell commands, file operations, git, screenshots, etc.). It is intended for **developers who understand the risks** of exposing an AI coding agent through Discord. There are no warranties, no guarantees of stability, and things may break or behave unexpectedly.
>
> This project exists primarily for **educational purposes** — to demonstrate Discord-to-AI automation patterns. Feel free to learn from it and take what you find useful, but understand that you are fully responsible for anything that happens when you run it.

A Discord bot that gives you a conversational interface to AI coding agents like [Claude Code](https://claude.ai/code) and [Devin CLI](https://docs.devin.ai/cli). Type messages in Discord channels and they're relayed directly to AI sessions running on your machine.

## How It Works

- Each Discord channel under the bot's category is an **independent AI session** with its own working directory
- Just **type a message** — no slash commands needed for normal interaction
- Sessions **persist across bot restarts** (session IDs saved to disk)
- **Image attachments** are automatically downloaded, resized, and passed to the AI
- Messages sent while the AI is busy are **queued** and processed in order
- **Multiple providers** — switch between Claude Code and Devin CLI per channel using `/provider`

## Commands

48 slash commands organized by category:

### Core

| Command | Description |
|---------|-------------|
| `/new` | Clear session and start fresh in the current channel |
| `/cancel` | Cancel the currently running AI session |
| `/model` | Quick model switch |
| `/status` | Show current session info, provider, working directory, and run state |
| `/browser` | Manage Chrome CDP connection for authenticated browser control |
| `/provider` | Switch or check the AI provider for this channel |

### Claude Integration

| Command | Description |
|---------|-------------|
| `/claude` | Send prompts to Claude Code CLI |
| `/continue` | Continue the most recent conversation in this directory |
| `/claude-enhanced` | Send message with advanced options |
| `/claude-models` | List available models and capabilities |
| `/claude-sessions` | Manage Claude Code sessions |
| `/claude-context` | Show context information that would be sent to Claude |

### Claude Development Tools

| Command | Description |
|---------|-------------|
| `/claude-explain` | Ask Claude to explain code, concepts, or errors |
| `/claude-debug` | Get help debugging code issues |
| `/claude-optimize` | Get code optimization suggestions |
| `/claude-review` | Get comprehensive code review |
| `/claude-generate` | Generate code, tests, or documentation |
| `/claude-refactor` | Refactor existing code with guidance |
| `/claude-learn` | Learn programming concepts with Claude as tutor |

### Git

| Command | Description |
|---------|-------------|
| `/git` | Execute git command |
| `/worktree` | Create git worktree |
| `/worktree-list` | List git worktrees |
| `/worktree-remove` | Remove git worktree |
| `/worktree-bots` | List running worktree bot processes |
| `/worktree-kill` | Kill a specific worktree bot process |

### Shell

| Command | Description |
|---------|-------------|
| `/shell` | Execute shell command (supports interactive commands) |
| `/shell-input` | Send stdin to running shell process |
| `/shell-list` | List running shell commands |
| `/shell-kill` | Stop running shell command |

### System Monitoring

| Command | Description |
|---------|-------------|
| `/system-info` | Display comprehensive system information |
| `/processes` | List running processes |
| `/system-resources` | Show CPU, memory, and disk usage |
| `/network-info` | Display network interfaces and connections |
| `/disk-usage` | Show disk space for all mounted drives |
| `/env-vars` | List environment variables |
| `/system-logs` | Show recent system logs |
| `/port-scan` | Check which ports are open/listening |
| `/service-status` | Check status of system services |
| `/uptime` | Show system uptime and load averages |

### Utility

| Command | Description |
|---------|-------------|
| `/pwd` | Show current working directory |
| `/shutdown` | Shutdown the bot |
| `/screenshot` | Capture and share a screenshot of the host screen |

### Settings

| Command | Description |
|---------|-------------|
| `/settings` | Manage all bot settings in one place |
| `/claude-settings` | Manage Claude Code specific settings |
| `/output-settings` | Configure output formatting and display |
| `/quick-model` | Quickly switch model for next conversation |

### Advanced

| Command | Description |
|---------|-------------|
| `/agent` | Interact with specialized AI agents |
| `/todos` | Manage development todos with API rate limit awareness |
| `/help` | Display detailed help for all commands |

## Quick Start

### Prerequisites

- [Deno](https://deno.com/) runtime
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) installed and logged in (`claude /login`)
- (Optional) [Devin CLI](https://docs.devin.ai/cli) installed and authenticated (`devin setup`)
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
CATEGORY_NAME=ai-bot                  # Discord category name for channels
WORK_DIR=/path/to/workspace           # Base working directory (default: ./workspace)
DEFAULT_PROVIDER=claude-code          # Default AI provider (claude-code or devin)
CLAUDE_PATH=/path/to/claude           # Path to Claude Code CLI (default: claude)
DEVIN_PATH=/path/to/devin             # Path to Devin CLI (default: devin)
```

Each channel under the category gets its own subfolder: `WORK_DIR/channel-name/` (defaults to `workspace/channel-name/`)

## Features

### Per-Channel Sessions
Each channel operates independently with its own:
- AI session (persisted to `.claude-sessions.json`)
- Working directory (`WORK_DIR/channel-name/`)
- Message queue
- Provider selection (Claude Code or Devin)

### Image Support
Attach images to your Discord messages and the AI will see them. Images are:
- Downloaded to the channel's working directory
- Automatically resized to max 1500px to stay within API limits (uses `sips` on macOS, `convert` on Linux)
- Referenced in the prompt so the AI can read them

> **Linux:** Install ImageMagick for image resizing: `sudo apt install imagemagick`

### Message Queuing
If you send a message while the AI is still processing, it gets queued automatically. Once the current task finishes, queued messages are processed in order.

### Streaming Output
AI responses stream to Discord in real-time as embedded messages:
- **Green** — Assistant text responses
- **Blue** — Tool use (with truncated preview + expand button)
- **Cyan** — Tool results (with truncated preview + expand button)
- **Purple** — Thinking blocks
- **Orange** — Edit operations (showing file path, old/new content)

### Multi-Provider Support
The bot supports multiple AI CLI backends:
- **Claude Code** — Full streaming JSON output, sub-agent heartbeats, session resume
- **Devin CLI** — Non-interactive mode (`devin -p`) with stdout streaming

Use `/provider set name:devin` to switch a channel to Devin, or `/provider list` to see available providers. The default provider is set via `DEFAULT_PROVIDER` in `.env`.

### Rate Limit Fallback
If the primary model hits a rate limit, the bot automatically retries with Claude Sonnet 4 (Claude Code provider only).

### Auto-Update (Production)
Run with `deno task prod` (or `bash run.sh`) to start the bot with automatic updates. The runner checks `origin/main` every 60 seconds and, if new commits are found, pulls changes and restarts the bot. It includes crash backoff to avoid burning Discord session quota if the bot keeps dying on startup.

### Run on Boot (systemd)
To start the bot automatically when your machine boots:

```bash
# 1. Copy the template service file
sudo cp claude-code-discord.service /etc/systemd/system/ai-bot.service

# 2. Edit it with your paths and username
sudo systemctl edit --full ai-bot

# 3. Enable and start
sudo systemctl enable --now ai-bot
```

Useful commands:
- `sudo systemctl status ai-bot` — check status
- `sudo journalctl -u ai-bot -f` — tail logs
- `sudo systemctl restart ai-bot` — restart

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
index.ts                     — Entry point, per-channel session management, message queuing
discord/                     — Discord.js client, message listener, command routing, formatting
claude/                      — Claude Code SDK wrapper, stream handling, Discord embed output
providers/                   — Provider abstraction layer (Claude Code, Devin CLI adapters)
core/                        — Slash command handlers, handler registry, button handlers, config
git/                         — Git and worktree command handlers
shell/                       — Shell execution with interactive stdin support
system/                      — System monitoring commands (processes, resources, network, etc.)
screenshot/                  — Host screen capture and sharing
settings/                    — Bot settings management (model, output, unified settings)
agent/                       — Specialized AI agent interactions
help/                        — Help command with full command reference
util/                        — Persistence, platform detection, usage tracking, process management
types/                       — Shared TypeScript types
tests/                       — Verification and integration tests
```

## License

MIT
