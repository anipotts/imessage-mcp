# imessage-mcp

Read-only MCP server for searching and reading the macOS Messages history from Claude, Codex, Cursor and other MCP clients. Published to npm and the MCP Registry.

## Stack
- TypeScript, `@modelcontextprotocol/server`, Zod, Node 24 (SQLite access to `chat.db`). Vitest for unit and e2e tests.

## Commands
- `npm run dev`, `npm run typecheck`, `npm test`, `npm run e2e`
- Before any release: `npm run verify` (typecheck, tests, e2e, audit, pack dry run). `npm run preflight` adds perf checks.

## Rules
- Read-only, always. Never add a tool that sends, edits or deletes messages.
- Privacy is a feature: strip location data from attachments and keep `PRIVACY.md` accurate.
- Keep `server.json`, `manifest.json` and `package.json` versions in sync, and add a `CHANGELOG.md` entry for user-visible changes.
- Follow `CONTRIBUTING.md` and `SECURITY.md`.
