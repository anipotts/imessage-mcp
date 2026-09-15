# Privacy policy

Effective 2026-09-15. This policy covers `imessage-mcp` in every form it ships: the npm package, the Claude Code plugin, and the Claude Desktop extension (`imessage-mcp.mcpb`).

imessage-mcp is open source software that runs entirely on your Mac. It has no accounts, no servers, and no analytics. The author receives none of your data.

## What it reads

- **Messages history** in the Messages database on your Mac, read-only, when an assistant calls one of its tools: message text, timestamps, handles (phone numbers and email addresses), conversation names, reactions, receipts, and attachment metadata.
- **Attachment content**, one file at a time, only when an assistant calls `get_attachment` at the `full` privacy mode. Images have location and camera metadata removed before they are returned.
- **Contact names** from the database Contacts.app keeps on your Mac, when contact names are on (`--contacts live`, the default). They are used only to put names on handles and are never modified.

macOS Full Disk Access, granted by you to the app that runs the server, gates all of it. The server cannot grant itself access.

## How it uses that data

Only to answer the tool call that asked for it. The privacy mode you choose (`full`, `redacted`, or `aggregate`) limits what a result can contain. The server cannot send, edit, or delete messages.

## Where it is stored

- **Search index.** Built from your messages and cached, encrypted, in `~/Library/Caches/imessage-mcp` so the next start is fast. The key comes from your Messages database itself, so only an app that can already read your messages can open it.
- **Nothing else.** No logs of your data are kept. Diagnostics contain tool names, durations, and error codes, never queries, names, handles, paths, or message text.

## Who it is shared with

- **Your MCP client and its model provider.** Results go to the app that launched the server (for example Claude, Codex, Cursor, or VS Code), which may send them to its model provider and keep them under that provider's policy. This is the purpose of the server. Use `redacted` or `aggregate` mode to limit what that app receives.
- **The public npm registry, for version checks only.** When `server_status` or `doctor` runs, the server may request `https://registry.npmjs.org/imessage-mcp/latest` to learn the newest version number, at most about twice a day. It sends no message data, contact data, or identifiers. Like any web request, the registry sees your IP address. Set `IMESSAGE_UPDATE_CHECK=0`, or turn off "Check for updates" in Claude Desktop, to stop it.
- **No one else.** There is no telemetry, crash reporting, advertising, or sale of data.

## Retention

The author retains nothing, because nothing is collected. The search index cache stays until you delete `~/Library/Caches/imessage-mcp` or macOS clears caches; the server rebuilds it when needed. Data returned to your MCP client is retained under that client's and its model provider's policies.

## Your choices

- Choose a stricter privacy mode, or turn contact names off, with `--privacy` and `--contacts` or in the Claude Desktop extension settings.
- Keep the index in memory only with `IMESSAGE_CACHE=0`.
- Revoke Full Disk Access in System Settings at any time.
- Uninstall by removing the server from your client and deleting `~/Library/Caches/imessage-mcp`.

## Changes

Changes to this policy are published in this file and noted in [CHANGELOG.md](CHANGELOG.md).

## Contact

- Questions and privacy requests: [open an issue](https://github.com/anipotts/imessage-mcp/issues). Do not include message contents, handles, or contact names in a public issue.
- Security or privacy vulnerabilities: [report privately](https://github.com/anipotts/imessage-mcp/security/advisories/new).
