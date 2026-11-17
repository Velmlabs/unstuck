#!/bin/sh
# Add Unstuck Browser to Claude Code: an MCP server with its own headless Chrome. fetch_page reads a page, and a
# human check on it brings you in through a link. Needs Chrome or Chromium installed (or: npx playwright install chromium).
claude mcp add unstuck -- npx -y @velmlabs/unstuck-engine --mcp --browser
