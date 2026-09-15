# privacy policy

Effective 2026-09-14. This policy covers the `imessage-mcp` server in every form it ships: the npm package, the Claude Code plugin, and the Claude Desktop extension (`imessage-mcp.mcpb`).

imessage-mcp is open source software that runs entirely on your Mac. It has no accounts, no servers, and no analytics. The author receives none of your data.

## what it reads

- **Messages history** in the Messages database on your Mac, read-only, when an assistant calls one of its tools. That can include message text, timestamps, handles (phone numbers and email addresses), conversation names, and attachment metadata such as filenames.
- **Contact names** from the Contacts app, only when contact names are on (`--contacts live`, the default). Contacts are used to put names on handles and are never modified.

macOS decides whether any of this is readable: Full Disk Access gates Messages, and the Contacts permission gates Contacts. The server cannot grant itself either.

## how it uses that data

Only to answer the tool call that asked for it: searching messages, reading a conversation, resolving a contact, computing counts, or reporting server status. The privacy ceiling you choose (`full`, `redacted`, or `aggregate`) limits what a result may contain. It cannot send, edit, or delete messages.

## where it is stored

- **Search index:** decoded message text for search is kept in memory while the server runs and is discarded when it stops. No message index is written to disk.
- **Two key files** under `~/Library/Application Support/imessage-mcp/` (owner-only permissions). They encrypt the conversation references the server hands out. They contain no message data.
- **No logs of your data:** diagnostics go to the launching app's log and contain tool names, durations, counts, and error codes, never queries, names, handles, paths, or message text.

## who it is shared with

- **Your MCP client and its model provider.** Results go to the app that launched the server (for example Claude Desktop, Claude Code, Codex, or Cursor), which may send them to its model provider and keep them under that provider's own policy. This is the purpose of the server, and it is the one place your data leaves this process. Use `redacted` or `aggregate` mode to limit what that app receives.
- **The public npm registry, for update checks only.** When `server_status` or `doctor` runs, the server may make one anonymous request to `https://registry.npmjs.org/imessage-mcp/latest` to learn the newest version number, at most about twice a day. It sends no message data, contact data, or identifiers; like any web request, the registry can see your IP address. Set `IMESSAGE_UPDATE_CHECK=0` to turn this off.
- **No one else.** There is no telemetry, crash reporting, advertising, or sale of data.

## retention

The author retains nothing, because nothing is collected. The in-memory index lasts only as long as the server process. The two key files remain until you remove them with `npx -y imessage-mcp@2 uninstall --client <client> --purge --yes` or delete the folder. Data returned to your MCP client is retained according to that client's and its model provider's policies.

## your choices

- Pick a stricter privacy ceiling or turn contact names off in the extension settings or with `--privacy` and `--contacts`.
- Revoke Full Disk Access or Contacts access in System Settings at any time.
- Uninstall from Claude Desktop Settings, Extensions, or with the `uninstall` command.

## changes

Changes to this policy are published in this file and noted in [CHANGELOG.md](CHANGELOG.md), with history in the repository.

## contact

- Questions and privacy requests: [open an issue](https://github.com/anipotts/imessage-mcp/issues). Do not include message contents, handles, or contact names in a public issue.
- Security or privacy vulnerabilities: [report privately](https://github.com/anipotts/imessage-mcp/security/advisories/new).
