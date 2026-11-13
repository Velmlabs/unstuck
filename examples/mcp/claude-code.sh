#!/bin/sh
# Add Unstuck to Claude Code. Chrome must be running with --remote-debugging-port=9222 (see README.md).
claude mcp add unstuck -e UNSTUCK_CDP_URL=http://127.0.0.1:9222 -- npx -y @velmlabs/unstuck-engine --mcp --open
