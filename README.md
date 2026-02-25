# imessage-mcp

[![npm version](https://img.shields.io/npm/v/imessage-mcp?style=flat-square)](https://www.npmjs.com/package/imessage-mcp)
[![npm downloads](https://img.shields.io/npm/dm/imessage-mcp?style=flat-square)](https://www.npmjs.com/package/imessage-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io)
[![CI](https://github.com/anipotts/imessage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anipotts/imessage-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

**25 tools for exploring your iMessage history on macOS.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/demo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/demo-light.png">
    <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/demo-dark.png" alt="imessage-mcp demo — emoji reactions analysis">
  </picture>
</p>

An [MCP server](https://modelcontextprotocol.io) that gives AI assistants read-only access to your local iMessage database. Search messages, analyze conversations, explore reactions, read receipts, reply threads, edited messages, effects, streaks, conversation patterns, and more. Nothing leaves your machine.

## Install

```bash
npm install -g imessage-mcp
```

Or run without installing:

```bash
npx imessage-mcp doctor
```

### Add to your AI client

```bash
# Claude Code (one command)
claude mcp add imessage -- npx -y imessage-mcp
```

### Claude Code Plugin

For slash commands and agents:

```bash
claude plugin add anipotts/imessage-mcp
```

```bash
# Claude Desktop — add to ~/Library/Application Support/Claude/claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```

See [Setup](#setup) for Cursor, Windsurf, VS Code, Codex CLI, Cline, JetBrains, and Zed.

### Prerequisites

1. **macOS** (iMessage is macOS-only)
2. **Node.js 18+** (`node --version`)
3. **Full Disk Access** for your terminal: System Settings > Privacy & Security > Full Disk Access

## Tools

25 tools across 9 categories. All read-only. All annotated with `readOnlyHint: true` for auto-approval.

### Messages

| Tool | Description |
|------|-------------|
| `search_messages` | Full-text search with filters: query, contact, date range, direction, group chat, attachments |
| `get_conversation` | Conversation thread with cursor-based pagination |

### Contacts

| Tool | Description |
|------|-------------|
| `list_contacts` | All contacts with message counts and date ranges |
| `get_contact` | Deep contact info with stats and yearly breakdown |
| `resolve_contact` | Fuzzy-match a name, phone number, or email to a contact |

### Analytics

| Tool | Description |
|------|-------------|
| `message_stats` | Aggregate stats with time-series grouping |
| `contact_stats` | Per-contact volumes, trends, and hourly patterns |
| `temporal_heatmap` | 7x24 activity heatmap (day-of-week by hour) |

### Memories

| Tool | Description |
|------|-------------|
| `on_this_day` | Messages from this date in past years |
| `first_last_message` | First and last message ever exchanged with a contact |

### Patterns

| Tool | Description |
|------|-------------|
| `who_initiates` | Who starts conversations? Initiation ratio per contact |
| `streaks` | Consecutive-day messaging streaks |
| `double_texts` | Detect double-texting and unanswered message patterns |
| `conversation_gaps` | Find the longest silences in a conversation |
| `forgotten_contacts` | Contacts you've lost touch with |

### Wrapped

| Tool | Description |
|------|-------------|
| `yearly_wrapped` | Spotify Wrapped for iMessage -- full year summary |

### Groups

| Tool | Description |
|------|-------------|
| `list_group_chats` | Group chats with member counts and activity |
| `get_group_chat` | Per-member stats and monthly activity timeline |

### Attachments & Media

| Tool | Description |
|------|-------------|
| `list_attachments` | Query attachments by contact, MIME type, and date range |

### Reactions, Receipts, Threads, Edits & Effects

| Tool | Description |
|------|-------------|
| `get_reactions` | Tapback distribution, top reactors, most-reacted messages |
| `get_read_receipts` | Read/delivery latency and unread patterns |
| `get_thread` | Reconstruct reply thread trees |
| `get_edited_messages` | Edited and unsent messages with timing |
| `get_message_effects` | Slam, loud, confetti, fireworks analytics |

### System

| Tool | Description |
|------|-------------|
| `help` | Full tool guide with usage examples |

## What Can You Ask?

Once connected, ask your AI assistant anything about your messages in plain language:

- "How many messages have I sent this year?"
- "Show my conversation with Mom"
- "Who reacts to my messages the most?"
- "What time of day am I most active texting?"
- "What was the first text I ever sent my partner?"
- "What was I texting about on this day last year?"
- "Do I always text first with [name]?"
- "What's my longest texting streak?"
- "Show me messages people unsent"
- "Give me my 2024 iMessage Wrapped"
- "Who have I lost touch with?"
- "Show me the longest silence between me and [name]"
- "Do I double-text [name] a lot?"
- "What are the most popular group chats?"

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/wrapped-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/wrapped-light.png">
    <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/wrapped-dark.png" alt="iMessage Wrapped — year-in-review summary">
  </picture>
</p>

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code

```bash
claude mcp add imessage -- npx -y imessage-mcp
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```

### OpenAI Codex CLI

```bash
codex --mcp-config '{"imessage":{"command":"npx","args":["-y","imessage-mcp"]}}'
```

Or add to `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```

<details>
<summary>Cursor</summary>

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```
</details>

<details>
<summary>Windsurf</summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```
</details>

<details>
<summary>VS Code (GitHub Copilot)</summary>

Add to `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```
</details>

<details>
<summary>Cline (VS Code)</summary>

Add via the Cline MCP settings UI, or edit `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}
```
</details>

<details>
<summary>JetBrains IDEs</summary>

Settings > Tools > AI Assistant > MCP Servers > Add:

- **Name:** `imessage`
- **Command:** `npx`
- **Args:** `-y imessage-mcp`
</details>

<details>
<summary>Zed</summary>

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "imessage": {
      "command": {
        "path": "npx",
        "args": ["-y", "imessage-mcp"]
      }
    }
  }
}
```
</details>

## CLI Commands

### `imessage-mcp doctor`

Run setup diagnostics. Checks macOS version, Node.js version, chat.db access, Full Disk Access, AddressBook, and message count.

```
$ npx imessage-mcp doctor

imessage-mcp doctor

  ✓ macOS: Running on macOS (darwin)
  ✓ Node.js: Node v22.0.0 (>= 18 required)
  ✓ chat.db: Found at /Users/you/Library/Messages/chat.db
  ✓ Full Disk Access: Database readable
  ✓ Messages: 97,432 messages indexed
  ✓ AddressBook: 342 contacts resolved

All checks passed — ready to use!
```

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/doctor-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/doctor-light.png">
    <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/doctor-dark.png" alt="imessage-mcp doctor output">
  </picture>
</p>

Pass `--json` for machine-readable output:

```bash
npx imessage-mcp doctor --json
```

### `imessage-mcp dump`

Export messages or contacts to JSON.

```bash
# Export last 1000 messages
npx imessage-mcp dump > messages.json

# Filter by contact
npx imessage-mcp dump --contact "+15551234567"

# Date range with custom limit
npx imessage-mcp dump --from 2024-01-01 --to 2024-12-31 --limit 5000

# Export contacts (excluding spam/promo by default)
npx imessage-mcp dump --contacts > contacts.json

# Include all contacts (even ones you never replied to)
npx imessage-mcp dump --contacts --all > all-contacts.json

# Export all messages (including unfiltered contacts)
npx imessage-mcp dump --all > all-messages.json
```

## Privacy & Security

imessage-mcp reads your local iMessage database in **read-only mode**. No data leaves your machine. Nothing is written, modified, uploaded, or shared.

The tool accesses exactly two locations on disk:

| Path | Access | Purpose |
|------|--------|---------|
| `~/Library/Messages/chat.db` | Read-only | Your iMessage database |
| `~/Library/Application Support/AddressBook/` | Read-only | Contact name resolution |

No other files are accessed. No external APIs are called. You can verify this yourself:

```bash
grep -rn "readFileSync\|openDatabase\|sqlite" src/
```

### Why Full Disk Access?

macOS protects `~/Library/Messages/chat.db`. Your terminal needs Full Disk Access to read it. This is an Apple requirement, not something imessage-mcp imposes.

### How your data flows

```
chat.db --> [imessage-mcp] --> stdio --> [Your MCP Client] --> AI Provider
  ^                                          ^
  Your Mac only                     Already authorized by you
```

imessage-mcp makes zero network requests. Your data only leaves your machine through your MCP client (Claude Desktop, Cursor, etc.), which you have already authorized separately.

## Safe Mode

Prevent message bodies from being sent to the AI. Only metadata (counts, dates, contact names) is returned. No actual message text.

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"],
      "env": { "IMESSAGE_SAFE_MODE": "1" }
    }
  }
}
```

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/safe-mode-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/safe-mode-light.png">
    <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/safe-mode-dark.png" alt="Safe Mode — all message bodies redacted">
  </picture>
</p>

Useful for demos, shared environments, or when you want analytics without exposing private conversations.

## Smart Filtering

By default, listing and global search tools only include contacts you have actually replied to. This filters out spam, promo texts, and unknown senders.

**Filtered tools:** `search_messages` (global), `list_contacts`, `message_stats` (global), `temporal_heatmap` (global), `who_initiates` (global), `streaks` (global), `on_this_day` (global), `forgotten_contacts`, `yearly_wrapped`.

**Unfiltered tools:** `get_conversation`, `get_contact`, `contact_stats`, `first_last_message`. These always return results for any contact you specify.

To include all contacts (including unrecognized senders), pass `include_all: true` to any filtered tool.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `IMESSAGE_DB` | `~/Library/Messages/chat.db` | Path to iMessage database |
| `IMESSAGE_SAFE_MODE` | `false` | Set to `1` to redact all message bodies. Tools return only metadata. |

## Troubleshooting

<details>
<summary><strong>"Cannot read chat.db" / SQLITE_CANTOPEN</strong></summary>

Grant Full Disk Access to your terminal app:

System Settings > Privacy & Security > Full Disk Access > enable your terminal app.

Restart your terminal after granting access.
</details>

<details>
<summary><strong>"No messages found"</strong></summary>

Make sure Messages.app has been used on this Mac and has synced your messages. Run `npx imessage-mcp doctor` to verify.
</details>

<details>
<summary><strong>Messages show phone numbers instead of names</strong></summary>

Contact resolution uses your macOS AddressBook. If contacts are only on your phone and not synced to your Mac, names will not resolve. Sync contacts via iCloud or add them in the Contacts app.
</details>

<details>
<summary><strong>Node.js version mismatch (MODULE_NOT_FOUND / NODE_MODULE_VERSION)</strong></summary>

Your MCP client's bundled Node.js version differs from the one that compiled better-sqlite3's native module.

Fix by pointing to your system Node directly:

1. Find your Node path: `which node` (usually `/opt/homebrew/bin/node` or `/usr/local/bin/node`)
2. Find imessage-mcp: `npm root -g` or `dirname $(which imessage-mcp)`
3. Replace `"command": "npx"` with your system Node:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/node_modules/imessage-mcp/bin/imessage-mcp.js"]
    }
  }
}
```
</details>

<details>
<summary><strong>Claude Desktop does not show the tools</strong></summary>

1. Verify the config file is at `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Restart Claude Desktop completely (Cmd+Q, then reopen)
3. Run `npx imessage-mcp doctor` to confirm the server works independently
</details>

## Uninstall

```bash
npm uninstall -g imessage-mcp
```

To revoke database access, remove your terminal from System Settings > Privacy & Security > Full Disk Access.

## How It Works

imessage-mcp reads `~/Library/Messages/chat.db` using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) in read-only mode with `query_only = ON`. Contact names are resolved from your macOS AddressBook automatically.

On macOS 14 (Sonoma) and later, Apple changed how message text is stored. Some messages have `NULL` in the `text` column but contain the actual text in the `attributedBody` binary blob. imessage-mcp extracts text from this blob automatically so no messages are left behind.

All 25 tools are annotated with `readOnlyHint: true` so MCP clients can auto-approve them without user prompts.

## Requirements

- **macOS** -- iMessage is macOS-only
- **Node.js 18+**
- **Full Disk Access** for your terminal app

## License

MIT
