#!/bin/bash

# restart-hub.sh - Robust script to restart the Local MCP Hub

set -e

echo "Restarting Local MCP Hub..."

# Function to check if port 3002 is in use
is_port_in_use() {
    lsof -i :3002 >/dev/null 2>&1
}

# Function to kill processes using port 3002
kill_port_processes() {
    echo "Killing processes using port 3002..."
    # Get PIDs of processes using port 3002
    PIDS=$(lsof -t -i :3002 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
        echo "Found processes: $PIDS"
        kill -TERM $PIDS 2>/dev/null || true
        sleep 2
        # Force kill if still running
        REMAINING=$(lsof -t -i :3002 2>/dev/null || true)
        if [ -n "$REMAINING" ]; then
            echo "Force killing remaining processes: $REMAINING"
            kill -KILL $REMAINING 2>/dev/null || true
        fi
    fi
}

# Function to kill hub.js processes specifically
kill_hub_processes() {
    echo "Killing hub.js processes..."
    pkill -f "node.*hub.js" 2>/dev/null || true
    pkill -f "ts-node.*hub.ts" 2>/dev/null || true
    sleep 1
}

# Kill existing processes
if is_port_in_use; then
    kill_port_processes
fi
kill_hub_processes

# Wait a bit more to ensure cleanup
sleep 2

# Verify port is free
if is_port_in_use; then
    echo "ERROR: Port 3002 is still in use after cleanup. Aborting."
    echo "Manual intervention required. Check: lsof -i :3002"
    exit 1
fi

echo "Port 3002 is now free"

# Build the project
echo "Building TypeScript..."
npm run build

# Start the hub in background
echo "Starting hub in background..."
nohup npm start > .tmp/hub-startup.log 2>&1 &
HUB_PID=$!

echo "Hub started with PID: $HUB_PID"
echo "Startup log: .tmp/hub-startup.log"

# Wait for hub to be fully initialized
echo "Waiting for hub to initialize completely..."
WAIT_TIME=0
MAX_WAIT=60

while [ $WAIT_TIME -lt $MAX_WAIT ]; do
    # Check health endpoint and parse mcp_tools_initialized status
    HEALTH_RESPONSE=$(curl -s http://localhost:3002/health 2>/dev/null || echo "")
    if [ -n "$HEALTH_RESPONSE" ]; then
        if echo "$HEALTH_RESPONSE" | grep -q '"mcp_tools_initialized":true'; then
            echo "Hub is fully initialized and ready!"
            echo "Health check: http://localhost:3002/health"
            echo "API endpoint: http://localhost:3002/v1"
            echo "View logs: tail -f .tmp/local-mcp-hub.log"
            exit 0
        fi
    fi
    sleep 1
    WAIT_TIME=$((WAIT_TIME + 1))
    if [ $((WAIT_TIME % 10)) -eq 0 ]; then
        echo "Still waiting... (${WAIT_TIME}s elapsed)"
    fi
done

echo ""
echo "ERROR: Hub failed to fully initialize within ${MAX_WAIT}s"
echo "Check startup log: cat .tmp/hub-startup.log"
echo "Check main log: tail .tmp/local-mcp-hub.log"
exit 1