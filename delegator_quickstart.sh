#!/usr/bin/env bash
set -euo pipefail

# Quickstart script to build and launch the MCP delegator.
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DELEGATOR_DIR="$ROOT_DIR/mcp-delegator"
LOG_FILE="$ROOT_DIR/mcp-delegator.log"
PID_FILE="$ROOT_DIR/server.pid"

cd "$DELEGATOR_DIR"

# Install deps (safe to rerun)
npm install

# Compile TypeScript to dist
npx tsc

# Start delegator via Node (stdio MCP server), log to file
node dist/main.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Delegator iniciado. PID $(cat "$PID_FILE"). Log: $LOG_FILE"

echo "Para detener: kill $(cat "$PID_FILE") && rm -f "$PID_FILE""
echo "Para desarrollo interactivo: npm start --prefix $DELEGATOR_DIR (usa tsx main.ts)"
