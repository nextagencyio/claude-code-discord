#!/bin/bash
#
# run.sh — Auto-updating bot runner
#
# Starts the Discord bot and checks for updates every 60 seconds.
# Restarts the bot when: (1) remote has new commits, (2) local HEAD moved
# past the running commit (e.g. local push), or (3) the bot crashes.
#
# Crash backoff: if the bot dies within 30s of starting, waits progressively
# longer (60s, 120s, 240s, up to 15m) to avoid burning Discord session quota.
# A code update always resets the backoff and restarts immediately.
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

# Crash backoff state
CRASH_COUNT=0
MAX_BACKOFF=900  # 15 minutes max
BOT_START_TIME=0
MIN_UPTIME=30    # Bot must survive 30s to reset crash counter

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

get_backoff() {
  local delay=$((60 * (2 ** (CRASH_COUNT - 1))))
  if [ "$delay" -gt "$MAX_BACKOFF" ]; then
    delay=$MAX_BACKOFF
  fi
  echo "$delay"
}

start_bot() {
  cd "$SCRIPT_DIR"
  RUNNING_COMMIT=$(git rev-parse HEAD)
  BOT_START_TIME=$(date +%s)
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

  # Only pull when the remote is GENUINELY AHEAD (HEAD is an ancestor of the
  # remote). Without this ancestor check, an unpushed local commit makes
  # LOCAL != REMOTE_HEAD forever, which restart-loops the bot every cycle.
  if [ "$LOCAL" != "$REMOTE_HEAD" ] && git merge-base --is-ancestor HEAD "$REMOTE/$BRANCH" 2>/dev/null; then
    # Remote has new commits (pushed from elsewhere) — pull and restart
    log "Remote update detected (local: ${LOCAL:0:8}, remote: ${REMOTE_HEAD:0:8})"
    stop_bot
    log "Pulling latest changes..."
    git pull "$REMOTE" "$BRANCH" --ff-only || {
      log "Error: git pull failed (merge conflict?). Skipping update."
      start_bot
      return
    }
    log "Update complete — resetting crash backoff"
    CRASH_COUNT=0
    start_bot
  elif [ "$LOCAL" != "$RUNNING_COMMIT" ]; then
    # Local HEAD moved past the running commit (local push) — restart with new code
    log "Local update detected (running: ${RUNNING_COMMIT:0:8}, current: ${LOCAL:0:8})"
    stop_bot
    log "New code on disk — resetting crash backoff"
    CRASH_COUNT=0
    start_bot
  fi
}

check_bot_alive() {
  if [ -n "$BOT_PID" ] && ! kill -0 "$BOT_PID" 2>/dev/null; then
    local now uptime
    now=$(date +%s)
    uptime=$((now - BOT_START_TIME))

    if [ "$uptime" -ge "$MIN_UPTIME" ]; then
      # Bot survived long enough — reset crash counter, restart immediately
      log "Bot died after ${uptime}s uptime, restarting..."
      CRASH_COUNT=0
      BOT_PID=""
      start_bot
    else
      # Bot crashed quickly — apply backoff
      CRASH_COUNT=$((CRASH_COUNT + 1))
      local delay
      delay=$(get_backoff)
      log "Bot crashed after ${uptime}s (crash #${CRASH_COUNT}), waiting ${delay}s before retry..."
      BOT_PID=""
      sleep "$delay"
      start_bot
    fi
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
