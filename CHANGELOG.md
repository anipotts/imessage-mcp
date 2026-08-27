# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Protected, idempotent recovery for downstream publication failures after a verified npm release.

### Changed
- GitHub releases are assembled as complete drafts, published once, made immutable, and verified with release and asset attestations.
- Public verification now records the exact beta.2 source, evidence lineage, artifact hashes, and reconciled npm, MCP Registry, and GitHub state.

## [2.0.0-beta.2] - 2026-08-26

### Fixed
- Trusted publication now passes npm an explicit local tarball path, preventing npm from interpreting the verified artifact path as a Git repository.

## [2.0.0-beta.1] - 2026-08-11

### Added
- Seven-tool, clean-break MCP API: `server_status`, `resolve_contact`, `list_conversations`, `get_conversation`, `search_messages`, `analyze_communication`, and `sync_messages`
- Explicit iMessage, SMS/MMS, RCS, and unknown-service families with schema capability states
- Full, redacted, and aggregate privacy ceilings with field-level leakage tests
- Authenticated stateless HTTP on loopback for use behind Tailscale Serve
- Exact Foundation decoding, memory-only FTS5 and trigram search, opaque keyset cursors, and caller-held sync cursors
- Synthetic fixtures, installed-package client checks, sealed release gates, and a one-million-message performance certification

### Changed
- Requires macOS 14 or newer and active Node 22, 24, or 26
- Opens live or faithfully copied Mac `chat.db` files in read-only, file-must-exist, SQLite query-only mode
- Android-originated SMS, MMS, and RCS are covered only when those conversations already appear in Apple Messages on the Mac
- Conversation joins now use `chat_message_join`, participants use `chat_handle_join`, and only Apple `chat_lookup` links merge service variants

### Fixed
- Conversation attribution, local date boundaries, search completeness and pagination, reaction parents, receipts, contact ambiguity, edited and retracted state, optional schemas, privacy leakage, HTTP exposure, and package metadata

### Removed
- Legacy aliases, dump/export, watcher state, SSE, Docker, Smithery, prompts, resources, bundled agents, and the 1.x plugin skills
- Heuristic attributed-body fallback and unrestricted legacy archive deserialization

Every 2.x version remains strictly read-only. Sending is reserved for the separately gated 3.0 roadmap.

## [1.5.0] - 2026-02-25

### Added
- **HTTP transport**: `--transport http` starts a Streamable HTTP server (MCP 2025-03-26 standard) on `/mcp` with session management
- **Legacy SSE transport**: `--transport sse` for older MCP clients that don't support Streamable HTTP
- **CLI flags**: `--transport` (`-t`), `--port` (`-p`), `--host` (`-H`) for flexible server configuration
- **Docker support**: multi-stage `Dockerfile` and `.dockerignore` for running as an HTTP server in containers
- **Smithery registry**: `smithery.yaml` for one-click install via [Smithery](https://smithery.ai)
- **iCloud Sync guide**: comprehensive documentation for syncing message history across Apple devices
- HTTP transport entry in `server.json` for MCP Registry discovery

### Changed
- README restructured: privacy moved up, tools collapsed, liberal use of `<details>` for a scannable layout
- Troubleshooting entries updated with iCloud sync cross-references

## [1.4.0] - 2026-02-25

### Added
- **`check_new_messages` tool**: track new messages since your last check with baseline + delta pattern
- **Real-time sync**: `IMESSAGE_SYNC=watch` uses macOS FSEvents for near-instant new message notifications
- **Poll sync**: `IMESSAGE_SYNC=poll:N` for polling every N seconds as an alternative to FSEvents
- **Forward pagination**: cursor-based pagination now supports both backward and forward navigation
- 26th tool (check_new_messages) bringing the total to 26

### Changed
- **100% TypeScript source**: all remaining JavaScript converted to TypeScript
- `get_conversation` supports forward pagination via `after` cursor

## [1.3.0] - 2026-02-25

### Added
- **Claude Code plugin**: 5 slash commands, 2 agents (`deep-dive`, `storyteller`), 3 enhanced skills, post-install hook
- **Contact name search**: search by name ("Mom") instead of phone number in `search_messages` and `get_conversation`
- Demo GIFs for light and dark mode
- Ready-to-paste JSON config in `doctor` output

### Fixed
- **Safe Mode gaps**: `get_message_effects`, `get_reactions`, `list_attachments`, and `get_edited_messages` now redact message bodies when `IMESSAGE_SAFE_MODE=1`

## [1.2.0] - 2026-02-24

### Added
- **Safe Mode** (`IMESSAGE_SAFE_MODE=1`): redacts all message bodies, returns only metadata
- **MCP Registry listing** via `server.json`
- Collapsible setup sections for 8 MCP clients in README

## [1.1.0] - 2026-02-24

### Added
- **Smart spam filtering**: only includes contacts you've replied to; opt out with `include_all: true`
- **Two-pass search**: fast SQL LIKE + `attributedBody` extraction for complete results on macOS 14+
- **Contact name resolution** from macOS AddressBook with fuzzy matching
- `resolve_contact` tool for matching names, phones, and emails
- `attributedBody` text extraction for macOS Sonoma+ messages with NULL `text` column

### Fixed
- Search now includes sent messages in spam filter results

## [1.0.0] - 2026-02-24

### Added
- **25 MCP tools** across 9 categories: messages, contacts, analytics, memories, patterns, wrapped, groups, attachments, reactions/receipts/threads/edits/effects, and help
- **Read-only** SQLite access with `readonly: true` and `query_only = ON`
- **Parameterized queries** for security — no SQL string interpolation
- `readOnlyHint: true` annotations for MCP client auto-approval
- **CLI commands**: `doctor` (setup diagnostics) and `dump` (JSON export)
- macOS `attributedBody` binary parser for Sonoma+ message text extraction
- AddressBook resolver with phone digit normalization and email lookup
