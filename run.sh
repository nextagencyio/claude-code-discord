#!/bin/bash
#
# run.sh — Auto-updating bot runner
#
# Starts the Discord bot and checks for updates every 60 seconds.
# Restarts the bot when: (1) remote has new commits, (2) local HEAD moved
# past the running commit (e.g. local push), or (3) the bot crashes.
#
# Usage: bash run.sh
#        deno task prod

set -euo pipefail

CHECK_INTERVAL=60
BRANCH="main"
REMOTE="origin"
BOT_PID=""
RUNNING_COMMIT=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

start_bot() {
  cd "$SCRIPT_DIR"
  RUNNING_COMMIT=$(git rev-parse HEAD)
  deno task start &
  BOT_PID=$!
  log "Bot started (PID: $BOT_PID) on commit ${RUNNING_COMMIT:0:8}"
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
    # Remote has new commits (pushed from elsewhere) — pull and restart
    log "Remote update detected (local: ${LOCAL:0:8}, remote: ${REMOTE_HEAD:0:8})"
    stop_bot
    log "Pulling latest changes..."
    git pull "$REMOTE" "$BRANCH" --ff-only || {
      log "Error: git pull failed (merge conflict?). Skipping update."
      start_bot
      return
    }
    log "Update complete"
    start_bot
  elif [ "$LOCAL" != "$RUNNING_COMMIT" ]; then
    # Local HEAD moved past the running commit (local push) — restart with new code
    log "Local update detected (running: ${RUNNING_COMMIT:0:8}, current: ${LOCAL:0:8})"
    stop_bot
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
