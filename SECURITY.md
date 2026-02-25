# Security

## Reporting Vulnerabilities

If you discover a security issue, please report it privately via [GitHub Issues](https://github.com/anipotts/imessage-mcp/issues) with the label "security" or email the maintainer directly.

Do not open a public issue for vulnerabilities that could be exploited.

## Design

- **Read-only access**: The database is opened with `readonly: true` and `query_only = ON`. No writes are possible.
- **Local only**: All queries run against your local `~/Library/Messages/chat.db`. No data is sent to external servers.
- **No network calls**: imessage-mcp makes zero network requests. Contact resolution uses your local macOS AddressBook.
- **Parameterized queries**: All SQL queries use better-sqlite3's built-in parameter binding. No string interpolation of user input.
