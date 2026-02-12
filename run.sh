#!/bin/bash
#
# run.sh — Auto-updating bot runner
#
# Starts the Discord bot and checks for new commits on origin/main every 60 seconds.
# If new commits are found, pulls changes and restarts the bot automatically.
# Also restarts the bot if it crashes unexpectedly.
#
# Usage: bash run.sh
#        deno task prod

set -euo pipefail

CHECK_INTERVAL=60
BRANCH="main"
REMOTE="origin"
BOT_PID=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

start_bot() {
  cd "$SCRIPT_DIR"
  deno task start &
  BOT_PID=$!
  log "Bot started (PID: $BOT_PID)"
}

stop_bot() {
  if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
    log "Stopping bot (PID: $BOT_PID)..."
    kill "$BOT_PID"
    wait "$BOT_PID" 2>/dev/null || true
    log "Bot stopped"
  fi
  BOT_PID=""
}

check_and_update() {
  cd "$SCRIPT_DIR"
  git fetch "$REMOTE" "$BRANCH" --quiet 2>/dev/null || {
    log "Warning: git fetch failed, skipping update check"
    return
  }

  local LOCAL REMOTE_HEAD
  LOCAL=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git rev-parse "$REMOTE/$BRANCH")

  if [ "$LOCAL" != "$REMOTE_HEAD" ]; then
    log "New commits detected (local: ${LOCAL:0:8}, remote: ${REMOTE_HEAD:0:8})"
    stop_bot
    log "Pulling latest changes..."
    git pull "$REMOTE" "$BRANCH" --ff-only || {
      log "Error: git pull failed (merge conflict?). Skipping update."
      start_bot
      return
    }
    log "Update complete"
    start_bot
  fi
}

check_bot_alive() {
  if [ -n "$BOT_PID" ] && ! kill -0 "$BOT_PID" 2>/dev/null; then
    log "Bot process died unexpectedly, restarting..."
    BOT_PID=""
    start_bot
  fi
}

cleanup() {
  log "Shutting down..."
  stop_bot
  exit 0
}

trap cleanup SIGINT SIGTERM

log "Auto-update runner starting (checking every ${CHECK_INTERVAL}s)"
start_bot

while true; do
  sleep "$CHECK_INTERVAL"
  check_bot_alive
  check_and_update
done
