---
name: imessage:doctor
description: "Diagnose setup issues"
---

## What This Does

Runs a diagnostic check on your iMessage MCP setup to verify everything is configured correctly. Checks system requirements, database access, permissions, and message availability so you can identify and fix issues before they block you.

## How To Use

Run the doctor command whenever something is not working as expected, or as a first step after installing the plugin. It will report pass/fail status for each check and suggest fixes for any failures.

## Tools Orchestrated

1. `help` tool -- Surfaces available tools and usage guidance
2. `npx imessage-mcp doctor` -- Runs the full diagnostic suite

### What It Checks

- **macOS version** -- Confirms you are on a supported macOS release
- **Node.js version** -- Verifies Node.js is installed and meets the minimum version
- **chat.db access** -- Tests read access to `~/Library/Messages/chat.db`
- **Full Disk Access** -- Confirms the terminal or app has Full Disk Access in System Settings
- **Message count** -- Validates that the database contains messages and is not empty
- **AddressBook access** -- Checks whether contact resolution can match names to handles

## Examples

- "Run the doctor to check my setup"
- "Something is broken -- can you diagnose it?"
- "I just installed imessage-mcp, is everything working?"
- "Why can't the search find any messages?"

## Tips

- Run this first if any tool returns errors or empty results
- The most common issue is missing Full Disk Access -- the doctor will flag it clearly
- If message count is zero, the database path may be wrong or the database may be locked by another process
- After fixing a permission issue, run the doctor again to confirm the fix
