#!/bin/bash
cd mcp-delegator
node dist/main.js > ../mcp-delegator.log 2>&1 &
echo $! > ../server.pid