# imessage-mcp

[![npm version](https://img.shields.io/npm/v/imessage-mcp?style=flat-square)](https://www.npmjs.com/package/imessage-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io)
[![CI](https://github.com/anipotts/imessage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anipotts/imessage-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

**26 tools for locally exploring your iMessage history with AI.**

<img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/demo-dark.gif" alt="imessage-mcp demo" width="100%">

An [MCP server](https://modelcontextprotocol.io) that gives AI assistants **read-only** access to your local iMessage database. Nothing is written, modified, or uploaded. Your messages stay on your Mac; the AI only sees what you ask about.

> **Read-only access to 2 local files** (`chat.db` + `AddressBook`). Zero network requests. Nothing is written, uploaded, or shared. All 26 tools are annotated `readOnlyHint: true` — your MCP client can auto-approve every call without prompts.

## Install

```bash
npm install -g imessage-mcp
```

Or run without installing:

```bash
npx imessage-mcp doctor
```

**[Smithery](https://smithery.ai):** One-click install via the Smithery registry — search for `imessage-mcp`.

### Add to your AI client

```bash
# Claude Code (one command)
claude mcp add imessage -- npx -y imessage-mcp
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

### Claude Code Plugin

For slash commands and agents:

```bash
claude plugin add anipotts/imessage-mcp
```

### Prerequisites

1. **macOS** (iMessage is macOS-only)
2. **Node.js 18+** (`node --version`)
3. **Database access** for your host application — macOS protects `chat.db` with its Application Data permission. Grant access in: **System Settings > Privacy & Security > Full Disk Access** and enable the app running the MCP server (your terminal, Claude Desktop, or Cursor). GUI apps like Claude Desktop and Cursor may already have this permission.
4. **Messages in iCloud** enabled on your Mac (if you use multiple devices) — see [iCloud Sync & Multiple Devices](#icloud-sync--multiple-devices)

## Privacy & Security

imessage-mcp reads your local iMessage database in **read-only mode**. No data leaves your machine. Nothing is written, modified, uploaded, or shared.

| Path | Access | Purpose |
| --- | --- | --- |
| `~/Library/Messages/chat.db` | Read-only | Your iMessage database |
| `~/Library/Application Support/AddressBook/` | Read-only | Contact name resolution |

No other files are accessed. No external APIs are called.

```
chat.db --> [imessage-mcp] --> stdio/http --> [Your MCP Client] --> AI Provider
  ^                                              ^
  Your Mac only                         Already authorized by you
```

## What Can You Ask?

Once connected, ask your AI assistant anything about your messages in plain language:

- "Give me my 2024 iMessage Wrapped"
- "Do I always text first with [name]?"
- "What's my longest texting streak?"
- "Who reacts to my messages the most?"
- "What was the first text I ever sent my partner?"
- "What was I texting about on this day last year?"
- "Do I double-text [name] a lot?"
- "Who have I lost touch with?"

<details>
<summary><strong>More examples</strong></summary>

- "Show me the longest silence between me and [name]"
- "How many messages have I sent this year?"
- "Show my conversation with Mom"
- "What time of day am I most active texting?"
- "Show me messages people unsent"
- "What are the most popular group chats?"

</details>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/wrapped-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/wrapped-light.png">
  <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/wrapped-dark.png" alt="iMessage Wrapped — year-in-review summary" width="100%">
</picture>

## Tools

26 tools across 10 categories. All read-only. All annotated with `readOnlyHint: true`.

| Tool | Description |
| --- | --- |
| `search_messages` | Full-text search with filters: query, contact, date range, direction, group chat, attachments |
| `yearly_wrapped` | Spotify Wrapped for iMessage — full year summary |
| `who_initiates` | Who starts conversations? Initiation ratio per contact |
| `streaks` | Consecutive-day messaging streaks |
| `get_reactions` | Tapback distribution, top reactors, most-reacted messages |
| `on_this_day` | Messages from this date in past years |

<details>
<summary><strong>All 26 tools</strong></summary>

| Tool | Description |
| --- | --- |
| `search_messages` | Full-text search with filters: query, contact, date range, direction, group chat, attachments |
| `get_conversation` | Conversation thread with cursor-based pagination |
| `list_contacts` | All contacts with message counts and date ranges |
| `get_contact` | Deep contact info with stats and yearly breakdown |
| `resolve_contact` | Fuzzy-match a name, phone number, or email to a contact |
| `message_stats` | Aggregate stats with time-series grouping |
| `contact_stats` | Per-contact volumes, trends, and hourly patterns |
| `temporal_heatmap` | 7x24 activity heatmap (day-of-week by hour) |
| `on_this_day` | Messages from this date in past years |
| `first_last_message` | First and last message ever exchanged with a contact |
| `who_initiates` | Who starts conversations? Initiation ratio per contact |
| `streaks` | Consecutive-day messaging streaks |
| `double_texts` | Detect double-texting and unanswered message patterns |
| `conversation_gaps` | Find the longest silences in a conversation |
| `forgotten_contacts` | Contacts you've lost touch with |
| `yearly_wrapped` | Spotify Wrapped for iMessage — full year summary |
| `list_group_chats` | Group chats with member counts and activity |
| `get_group_chat` | Per-member stats and monthly activity timeline |
| `list_attachments` | Query attachments by contact, MIME type, and date range |
| `get_reactions` | Tapback distribution, top reactors, most-reacted messages |
| `get_read_receipts` | Read/delivery latency and unread patterns |
| `get_thread` | Reconstruct reply thread trees |
| `get_edited_messages` | Edited and unsent messages with timing |
| `get_message_effects` | Slam, loud, confetti, fireworks analytics |
| `check_new_messages` | Track new messages since your last check (baseline + delta) |
| `help` | Full tool guide with usage examples |

</details>

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

<details>
<summary><strong>OpenAI Codex CLI</strong></summary>

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

</details>

<details>
<summary><strong>Cursor</strong></summary>

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
<summary><strong>Windsurf</strong></summary>

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
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

Add to `.vscode/mcp.json` in your project root:

**stdio (default):**

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

**HTTP transport (remote / Docker):**

```json
{
  "servers": {
    "imessage": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

</details>

<details>
<summary><strong>Cline (VS Code)</strong></summary>

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
<summary><strong>JetBrains IDEs</strong></summary>

Settings > Tools > AI Assistant > MCP Servers > Add:

- **Name:** `imessage`
- **Command:** `npx`
- **Args:** `-y imessage-mcp`

</details>

<details>
<summary><strong>Zed</strong></summary>

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

<details>
<summary><strong><code>imessage-mcp doctor</code></strong> — run setup diagnostics</summary>

Checks macOS version, Node.js version, chat.db access, database permissions, AddressBook, and message count.

```
$ npx imessage-mcp doctor

imessage-mcp doctor

  ✓ macOS: Running on macOS (darwin)
  ✓ Node.js: Node v22.0.0 (>= 18 required)
  ✓ chat.db: Found at /Users/you/Library/Messages/chat.db
  ✓ Database access: Database readable
  ✓ Messages: 97,432 messages indexed
  ✓ AddressBook: 342 contacts resolved

All checks passed — ready to use!
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/doctor-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/doctor-light.png">
  <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/doctor-dark.png" alt="imessage-mcp doctor output" width="100%">
</picture>

Pass `--json` for machine-readable output:

```bash
npx imessage-mcp doctor --json
```

</details>

<details>
<summary><strong><code>imessage-mcp dump</code></strong> — export messages or contacts to JSON</summary>

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

</details>

## Transport Modes

By default, imessage-mcp uses **stdio** transport — the standard for local MCP clients like Claude Desktop and Claude Code. For workflow tools (n8n, Lutra, Copilot Studio) or remote access, HTTP transport is available.

| Flag | Short | Default | Description |
| --- | --- | --- | --- |
| `--transport` | `-t` | `stdio` | Transport mode: `stdio`, `http`, or `sse` |
| `--port` | `-p` | `3000` | Port for HTTP/SSE transport |
| `--host` | `-H` | `127.0.0.1` | Bind address (use `0.0.0.0` for Docker/remote) |

<details>
<summary><strong>Streamable HTTP</strong> (recommended for HTTP)</summary>

```bash
npx imessage-mcp --transport http --port 3000
```

Starts a Streamable HTTP server on `http://127.0.0.1:3000/mcp`. Supports `POST`, `GET`, and `DELETE` on `/mcp` with session management via `mcp-session-id` headers. This is the MCP 2025-03-26 standard.

</details>

<details>
<summary><strong>Legacy SSE</strong> (for older clients)</summary>

```bash
npx imessage-mcp --transport sse --port 3000
```

Starts a legacy SSE server: `GET /sse` to establish the stream, `POST /messages?sessionId=<id>` for JSON-RPC requests. Use this only if your client does not support Streamable HTTP.

</details>

## Docker

Run imessage-mcp as an HTTP server in Docker. Copy your `chat.db` to a volume mount:

```bash
docker build -t imessage-mcp .
docker run -p 3000:3000 -v /path/to/chat.db:/data/chat.db:ro imessage-mcp
```

The container starts with `--transport http --host 0.0.0.0` on port 3000 by default. Connect any MCP client to `http://localhost:3000/mcp`.

To secure the HTTP endpoint with authentication:

```bash
docker run -p 3000:3000 -e IMESSAGE_API_TOKEN=your-secret-token -v /path/to/chat.db:/data/chat.db:ro imessage-mcp
```

All requests must then include the `Authorization: Bearer your-secret-token` header.

<details>
<summary><strong>Safe Mode</strong> — redact all message bodies</summary>

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

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/safe-mode-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/safe-mode-light.png">
  <img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/safe-mode-dark.png" alt="Safe Mode — all message bodies redacted" width="100%">
</picture>

Useful for demos, shared environments, or when you want analytics without exposing private conversations.

</details>

<details>
<summary><strong>Smart Filtering</strong> — spam/promo exclusion</summary>

By default, listing and global search tools only include contacts you have actually replied to. This filters out spam, promo texts, and unknown senders.

**Filtered tools:** `search_messages` (global), `list_contacts`, `message_stats` (global), `temporal_heatmap` (global), `who_initiates` (global), `streaks` (global), `on_this_day` (global), `forgotten_contacts`, `yearly_wrapped`.

**Unfiltered tools:** `get_conversation`, `get_contact`, `contact_stats`, `first_last_message`, `conversation_gaps`, `get_reactions`, `get_read_receipts`, `get_thread`, `get_edited_messages`, `get_message_effects`, group chats, attachments, `check_new_messages`.

To include all contacts (including unrecognized senders), pass `include_all: true` to any filtered tool.

</details>

<details>
<summary><strong>Sync & New Messages</strong> — real-time notifications</summary>

> **Looking for iCloud sync?** This section covers real-time message tracking within imessage-mcp. To sync your full message history from iPhone/iPad to your Mac, see [iCloud Sync & Multiple Devices](#icloud-sync--multiple-devices).

By default, every query reads the latest data — if someone texts you, your next tool call sees it immediately. No sync needed.

For proactive awareness, the `check_new_messages` tool tracks what arrived since your last check:

1. First call sets a baseline
2. Subsequent calls report the delta — count, who messaged, and optional text previews

For push notifications (opt-in):

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"],
      "env": { "IMESSAGE_SYNC": "watch" }
    }
  }
}
```

This watches your iMessage database for changes and notifies your AI client within seconds. Uses macOS FSEvents — zero CPU when idle.

</details>

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `IMESSAGE_DB` | `~/Library/Messages/chat.db` | Path to iMessage database |
| `IMESSAGE_SAFE_MODE` | `false` | Set to `1` to redact all message bodies |
| `IMESSAGE_SYNC` | `off` | Sync mode: `off`, `watch` (FSEvents), or `poll:N` (every N seconds) |
| `IMESSAGE_API_TOKEN` | _(none)_ | Bearer token for HTTP/SSE auth. If set, requests must include `Authorization: Bearer <token>` |

<details>
<summary><strong>iCloud Sync & Multiple Devices</strong></summary>

### iCloud Sync & Multiple Devices

imessage-mcp reads your Mac's local database (`~/Library/Messages/chat.db`). This database only contains messages that have been **synced to your Mac**. If your conversations live on your iPhone or iPad but haven't synced, imessage-mcp won't see them.

> If you only use iMessage on your Mac, you can skip this — your messages are already in `chat.db`.

### How iMessage sync works

Apple's "Messages in iCloud" keeps your full message history synchronized across all your Apple devices:

```
┌─────────────┐         ┌──────────┐         ┌──────────────┐
│ iPhone/iPad │ ──────►  │  iCloud  │ ──────►  │   Your Mac   │
│  (sends &   │ ◄──────  │(Messages │ ◄──────  │              │
│  receives)  │         │in iCloud)│         │  chat.db      │
└─────────────┘         └──────────┘         └──────┬───────┘
                                                     │
                                                     ▼
                                              imessage-mcp
                                              reads this ↑
```

Without "Messages in iCloud" enabled **on your Mac**, the Mac's `chat.db` only contains messages sent and received while Messages.app was actively running on that Mac.

### Setup

#### 1. Enable on your Mac

<img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/icloud-messages-mac-dark.png" alt="Messages.app Settings — Enable Messages in iCloud" width="100%">

1. Open **Messages.app** on your Mac
2. Go to **Settings** (Cmd+,) > **iMessage** tab
3. Check **"Enable Messages in iCloud"**
4. Keep Messages.app open — sync begins automatically

#### 2. Enable on your iPhone/iPad

<img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/icloud-messages-iphone-dark.png" alt="iPhone Settings — Messages in iCloud toggle" width="100%">

1. Open **Settings** > tap your **name** (Apple ID) > **iCloud** > **Messages**
2. Toggle **"Use on this iPhone"** ON

#### 3. Same Apple ID on all devices

All devices must be signed into the **same Apple ID**. Check: Mac (System Settings > Apple ID), iPhone (Settings > tap your name).

#### 4. Wait for sync to complete

Initial sync can take **hours or even days** for large message histories. During sync:

- Messages.app must remain **open** on your Mac
- Your Mac should be connected to **Wi-Fi and power**
- You'll see a **"Syncing with iCloud"** status in Messages.app

<img src="https://raw.githubusercontent.com/anipotts/imessage-mcp/main/assets/icloud-sync-progress-dark.png" alt="Messages.app — Downloading messages from iCloud progress" width="100%">

#### 5. Sync contacts for name resolution

imessage-mcp resolves phone numbers to names using your Mac's AddressBook. If contacts only exist on your iPhone:

1. Open **System Settings** > **Apple ID** > **iCloud**
2. Find **Contacts** and toggle it **ON**
3. Wait for contacts to sync (usually under a minute)

### Verify sync is complete

```bash
npx imessage-mcp doctor
```

Look for the **Messages** line — it shows how many messages are indexed locally. If this number seems low, iCloud sync is likely still in progress. Run `doctor` again later to confirm the count has stabilized.

> **Tip:** On your iPhone, go to **Settings > General > iPhone Storage > Messages** to see your total message history size. Compare with what `doctor` reports on your Mac.

### Common sync issues

**Messages on iPhone don't appear on Mac:** "Messages in iCloud" must be enabled on **both** devices. Ensure both use the same Apple ID. Keep Messages.app open on your Mac. Run `npx imessage-mcp doctor` periodically to check if the count is growing.

**Brand-new Mac shows no history:** Expected — enable "Messages in iCloud," connect to Wi-Fi and power, keep Messages.app open. For large histories (100K+ messages), initial sync may take 1–2 days.

**History is incomplete:** Sync may still be in progress. If iCloud storage is full, sync pauses (check System Settings > Apple ID > iCloud > Manage Storage). Messages sent while sync was disabled won't sync retroactively.

**Group chats missing members:** Group chat sync can lag behind 1:1 conversations. Ensure sync is enabled on all devices and has had time to complete. If members show as phone numbers, enable iCloud Contacts sync (step 5 above).

</details>

## Troubleshooting

<details>
<summary><strong>"Cannot read chat.db" / SQLITE_CANTOPEN</strong></summary>

macOS protects `chat.db` with its Application Data permission. To grant access:

1. Open **System Settings > Privacy & Security > Full Disk Access**
2. Enable the app running the MCP server (your terminal, Claude Desktop, Cursor, etc.)
3. Restart the app after granting access

GUI apps like Claude Desktop and Cursor may already have this permission — try running `npx imessage-mcp doctor` first.

</details>

<details>
<summary><strong>Messages are missing or history is incomplete</strong></summary>

imessage-mcp reads only messages synced to your Mac. See [iCloud Sync & Multiple Devices](#icloud-sync--multiple-devices) for full setup steps.

Quick checklist:
1. Open Messages.app > Settings > iMessage > enable "Messages in iCloud"
2. Ensure the same Apple ID is signed in on all your devices
3. Connect to Wi-Fi and power — initial sync can take hours
4. Run `npx imessage-mcp doctor` to check message count

</details>

<details>
<summary><strong>"No messages found"</strong></summary>

Make sure Messages.app has been used on this Mac and has synced your messages. If you recently set up this Mac or just enabled "Messages in iCloud," sync may still be in progress — see [iCloud Sync & Multiple Devices](#icloud-sync--multiple-devices). Run `npx imessage-mcp doctor` to verify your setup and message count.

</details>

<details>
<summary><strong>Messages show phone numbers instead of names</strong></summary>

Contact resolution uses your macOS AddressBook. If contacts are only on your phone and not synced to your Mac, names will not resolve. See [iCloud Sync & Multiple Devices](#icloud-sync--multiple-devices) for instructions on enabling iCloud contact sync, or add contacts manually in the Contacts app.

</details>

<details>
<summary><strong>Node.js version mismatch (MODULE_NOT_FOUND / NODE_MODULE_VERSION)</strong></summary>

Your MCP client's bundled Node.js version differs from the one that compiled better-sqlite3's native module. Fix by pointing to your system Node directly:

1. Find your Node path: `which node`
2. Find imessage-mcp: `npm root -g`
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

## How It Works

imessage-mcp reads `~/Library/Messages/chat.db` using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) in read-only mode with `query_only = ON`. Zero network requests. Contact names are resolved from your macOS AddressBook automatically.

On macOS 14 (Sonoma) and later, Apple changed how message text is stored. Some messages have `NULL` in the `text` column but contain the actual text in the `attributedBody` binary blob. imessage-mcp extracts text from this blob automatically so no messages are left behind.

All 26 tools are annotated with `readOnlyHint: true` so MCP clients can auto-approve them without user prompts.

## License

MIT
