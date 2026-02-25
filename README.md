# imessage-mcp

25 tools for exploring your iMessage history on macOS.

Read-only access to your Mac's iMessage database — search messages, analyze conversations, explore reactions, read receipts, reply threads, edited messages, effects, streaks, conversation patterns, and more.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard that lets AI assistants like Claude connect to external data sources. imessage-mcp gives Claude (or any MCP client) read-only access to your local iMessage database so you can ask questions about your messaging history in natural language.

## Setup

### 1. Grant Full Disk Access

System Settings → Privacy & Security → Full Disk Access → enable your terminal app (Terminal, iTerm2, Warp, etc.)

### 2. Run diagnostics

```bash
npx imessage-mcp doctor
```

### 3. Add to your MCP client

#### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

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

#### Claude Code (CLI)

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

#### Cursor

`~/.cursor/mcp.json`:

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

#### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

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

#### VS Code (GitHub Copilot)

`.vscode/mcp.json` in your project root:

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

#### Cline (VS Code)

Add via Cline MCP settings UI, or `cline_mcp_settings.json`:

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

#### JetBrains IDEs

Settings → Tools → AI Assistant → MCP Servers → Add:
- Name: `imessage`
- Command: `npx`
- Args: `-y imessage-mcp`

#### Zed

`~/.config/zed/settings.json`:

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

## Tools

| Tool | Category | What it does |
|------|----------|--------------|
| `search_messages` | Messages | Full-text search with filters (query, contact, date, direction, group, attachments) |
| `get_conversation` | Messages | Conversation thread with cursor-based pagination |
| `list_contacts` | Contacts | All contacts with message counts and date ranges |
| `get_contact` | Contacts | Deep contact info: stats, yearly breakdown |
| `resolve_contact` | Contacts | Fuzzy-match name/phone/email to contact |
| `message_stats` | Analytics | Aggregate stats with time-series grouping |
| `contact_stats` | Analytics | Per-contact volumes, trends, hourly patterns |
| `temporal_heatmap` | Analytics | 7×24 activity heatmap (day-of-week × hour) |
| `on_this_day` | Memories | Messages from this date in past years |
| `first_last_message` | Memories | First and last message ever exchanged with a contact |
| `who_initiates` | Patterns | Who starts conversations? Initiation ratio per contact |
| `streaks` | Patterns | Consecutive-day messaging streaks |
| `double_texts` | Patterns | Detect double-texting and unanswered message patterns |
| `conversation_gaps` | Patterns | Find the longest silences in a conversation |
| `forgotten_contacts` | Patterns | Contacts you've lost touch with |
| `yearly_wrapped` | Wrapped | Spotify Wrapped for iMessage — full year summary |
| `list_group_chats` | Groups | Group chats with member counts and activity |
| `get_group_chat` | Groups | Per-member stats, monthly activity timeline |
| `list_attachments` | Attachments | Query by contact, MIME type, date range |
| `get_reactions` | Reactions | Tapback distribution, top reactors, most-reacted messages |
| `get_read_receipts` | Receipts | Read/delivery latency, unread patterns |
| `get_thread` | Threads | Reconstruct reply thread trees |
| `get_edited_messages` | Edits | Edited and unsent messages with timing |
| `get_message_effects` | Effects | Slam, loud, confetti, fireworks analytics |
| `help` | System | Full tool guide and examples |

## Example Queries

Once connected, try asking Claude things like:

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

## CLI Commands

### `imessage-mcp`

Start the MCP server (stdio transport). This is what Claude Desktop calls automatically.

### `imessage-mcp doctor`

Run setup diagnostics. Checks macOS, Node version, chat.db access, Full Disk Access, AddressBook, and message count.

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

Pass `--json` for machine-readable output:

```bash
npx imessage-mcp doctor --json
```

### `imessage-mcp dump`

Export messages to JSON. Pipe to a file or process with `jq`.

```bash
# Export last 1000 messages
npx imessage-mcp dump > messages.json

# Filter by contact
npx imessage-mcp dump --contact "+15551234567"

# Date range with custom limit
npx imessage-mcp dump --from 2024-01-01 --to 2024-12-31 --limit 5000

# Export contacts (excluding spam/promo contacts by default)
npx imessage-mcp dump --contacts > contacts.json

# Include ALL contacts (including ones you never replied to)
npx imessage-mcp dump --contacts --all > all-contacts.json

# Export all messages (including from unfiltered contacts)
npx imessage-mcp dump --all > all-messages.json
```

## Privacy

imessage-mcp reads your local iMessage database in **read-only mode**. No data leaves your machine — all queries run locally against `~/Library/Messages/chat.db`. Nothing is written, modified, uploaded, or shared. Contact names are resolved from your macOS AddressBook locally. No external APIs are called.

## Troubleshooting

### "Cannot read chat.db" / SQLITE_CANTOPEN

Grant Full Disk Access to your terminal: System Settings → Privacy & Security → Full Disk Access → enable your terminal app. Then restart your terminal.

### "No messages found"

Make sure Messages.app has been used on this Mac and has synced your messages. Run `npx imessage-mcp doctor` to verify.

### Messages show phone numbers instead of names

Contact resolution uses your macOS AddressBook. If contacts aren't synced to your Mac (e.g. only on your phone), names won't resolve. Sync contacts via iCloud or add them in the Contacts app.

### Node.js version mismatch (MODULE_NOT_FOUND / NODE_MODULE_VERSION)

If you see `MODULE_NOT_FOUND` or `NODE_MODULE_VERSION` errors, your MCP client's bundled Node.js version differs from the one that compiled better-sqlite3's native module.

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

### Claude Desktop doesn't show the tools

1. Make sure the config file is at `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Restart Claude Desktop completely (Cmd+Q, then reopen)
3. Run `npx imessage-mcp doctor` to verify the server works

## How It Works

Reads `~/Library/Messages/chat.db` using better-sqlite3 in read-only mode with `query_only = ON`. Contact names are resolved from your macOS AddressBook automatically — no configuration needed.

On macOS 14 (Sonoma) and later, Apple changed how message text is stored. Some messages have `NULL` in the `text` column but contain the actual text in the `attributedBody` binary blob. imessage-mcp extracts text from this blob automatically — no messages left behind.

All 25 tools are annotated with `readOnlyHint: true` so MCP clients can auto-approve them without prompting.

## Smart Filtering

By default, listing and global search tools only include contacts you've actually replied to — filtering out spam, promo texts, and unknown senders. This affects: `search_messages` (global), `list_contacts`, `message_stats` (global), `temporal_heatmap` (global), `who_initiates` (global), `streaks` (global), `on_this_day` (global), `forgotten_contacts`, and `yearly_wrapped`.

Contact-specific tools like `get_conversation`, `get_contact`, `contact_stats`, and `first_last_message` are not filtered — they always return results for any contact you specify.

To include all contacts (including unrecognized senders), pass `include_all: true` to any filtered tool.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `IMESSAGE_DB` | `~/Library/Messages/chat.db` | Path to iMessage database |

## Requirements

- **macOS** (iMessage is macOS-only)
- **Node.js 18+**
- **Full Disk Access** for your terminal app

## License

MIT
