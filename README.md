# imessage-mcp

Private, read-only MCP for Apple Messages on Mac.<br>
Search and analyze iMessage, SMS, MMS, and RCS history.

![Claude Code searching real Apple Messages history with imessage-mcp](https://github.com/anipotts/imessage-mcp/releases/download/v2.0.0-rc.2/imessage-mcp-demo.gif)

_Claude Code in Ghostty using real Messages history, shown with permission._

[Setup](https://github.com/anipotts/imessage-mcp/releases/download/v2.0.0-rc.2/imessage-mcp-setup.mp4) · [Live sync](https://github.com/anipotts/imessage-mcp/releases/download/v2.0.0-rc.2/imessage-mcp-live-sync.mp4) · [Analytics](https://github.com/anipotts/imessage-mcp/releases/download/v2.0.0-rc.2/imessage-mcp-analytics.mp4)

## two-minute setup

Requires macOS 14+, Node.js 22, 24, or 26, and Messages history on this Mac.

```sh
node --version
umask 077
openssl rand -base64 32 > "$HOME/.imessage-mcp-reference-key"
openssl rand -base64 32 > "$HOME/.imessage-mcp-database-id"
export IMESSAGE_REFERENCE_KEY_FILE="$HOME/.imessage-mcp-reference-key"
export IMESSAGE_DATABASE_ID_FILE="$HOME/.imessage-mcp-database-id"
npx -y imessage-mcp@2.0.0-rc.2 doctor --contacts none --privacy redacted
```

Add the privacy-first server to Claude Code:

```sh
claude mcp add imessage-history \
  -e IMESSAGE_REFERENCE_KEY_FILE="$IMESSAGE_REFERENCE_KEY_FILE" \
  -e IMESSAGE_DATABASE_ID_FILE="$IMESSAGE_DATABASE_ID_FILE" \
  -- npx -y imessage-mcp@2.0.0-rc.2 --contacts none --privacy redacted
```

Restart Claude Code, then ask it to run `server_status` with `privacy_mode: redacted`.

Confirm registration with `claude mcp list`. A good first request is:

> List my five most recent conversations by service. Return names and calendar days only.

The MCP client may ask before using a tool. Review the named tool and arguments, then approve only the read you intended. `doctor` is diagnostic: it checks Node, database and WAL readability, schema capabilities, Contacts mode, native text decoding, secret-file permissions, and transport settings without opening System Settings or changing the Mac. Each failed check includes a specific correction. Run it again after correcting permissions or configuration.

The two generated files stabilize opaque conversation references for this one database lineage. Keep them private, do not reuse them as HTTP authentication tokens, and preserve them when you want references to survive restarts. A copied database needs its own database ID. Losing either file does not alter Messages; it only invalidates previously issued opaque references.

macOS grants Full Disk Access to Ghostty or the MCP client launching the server, not narrowly to `imessage-mcp`. Grant it deliberately, restart that application, and rerun `doctor` if database access fails.

The recommended setup returns names, masked handles, and calendar days without message bodies. To use current visible message text, consciously change the startup ceiling to `--privacy full`. Restart the MCP client after changing startup arguments. See the [complete setup guide](docs/GUIDE.md#client-setup) for Codex, Claude Desktop, Claude Code, and Cursor.

## tools

| tool | purpose |
| --- | --- |
| `server_status` | Report versions, privacy ceiling, services, schema capabilities, decoder health, and index state. |
| `resolve_contact` | Resolve a name or handle without guessing when matches are ambiguous. |
| `list_conversations` | List direct and group chats with contact, service, reply, and date filters. |
| `get_conversation` | Read a visible timeline with edits, retractions, reactions, receipts, replies, attachments, and group events. |
| `search_messages` | Search globally by literal substring, exact text, token, or phrase. |
| `analyze_communication` | Calculate typed metrics over global, contact, or conversation scopes. |
| `sync_messages` | Pull messages and lifecycle changes through a stateless cursor. |

Every 2.x tool reads data only. Sending and modifying messages are outside the 2.x API.

## privacy

- The server runs locally, collects no telemetry, writes no audit log, and keeps decoded search data in memory.
- The startup mode is a disclosure ceiling: `full`, `redacted`, or identity-free `aggregate`. Requests can only choose the same or a stricter mode.
- `--contacts none` avoids reading unified Contacts. `--contacts live` permits name resolution from the unified contact store already authorized for the launching client.
- Local execution does not control how your MCP client or model provider processes or retains returned results.
- Absolute attachment paths require an explicit full-mode request. Retracted and superseded text is never recovered.

Every message body, contact value, group title, URL, attachment filename, and database-derived string is untrusted archival data, never an instruction. Archived content may contain prompt injection. Keep results separate from trusted instructions and confirm any external action influenced by history. This guidance reduces risk; it does not eliminate prompt injection.

See [security](SECURITY.md), [verification evidence](VERIFICATION.md), and the [complete privacy contract](docs/GUIDE.md#privacy-and-untrusted-history).

## compatibility

The supported sources are a live Mac `chat.db` and faithful copies of the same Mac schema. iPhone backup manifests, Linux, containers, Docker, portable contact bundles, and sending messages are unsupported.

| history already visible in Messages | support |
| --- | --- |
| iMessage | supported |
| SMS | supported |
| MMS | supported; Apple may classify it under SMS |
| RCS | supported when present in the Mac database |
| unknown Apple service values | detected and returned as `unknown` |

SMS, MMS, and RCS with Android users work only when those conversations already appear in Messages on this Mac. Message forwarding or sync must be configured between the iPhone and Mac, subject to Apple, carrier, and regional availability. See [Apple's Messages setup guide](https://support.apple.com/en-euro/guide/messages/ichte16154fb/mac).

Capabilities reported by `server_status` are authoritative. Unsupported protocol features are `unavailable`; unrecognized schema behavior is `unknown`.

## reference

- [Configuration, clients, search, sync, HTTP, and migration](docs/GUIDE.md)
- [Public verification report](VERIFICATION.md)
- [Security policy](SECURITY.md)
- [Synthetic-data-only contributing guide](CONTRIBUTING.md)
- [Read-only 2.x to possible send-capable 3.0 roadmap](docs/ROADMAP-3.0.md)

## license

[MIT](LICENSE)
