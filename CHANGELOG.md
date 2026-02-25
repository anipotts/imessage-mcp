# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-02-25

### Added
- **Claude Code plugin architecture**: 5 slash commands (`/imessage:search`, `/imessage:wrapped`, `/imessage:analyze`, `/imessage:memories`, `/imessage:doctor`), 2 agents (`deep-dive`, `storyteller`), 3 enhanced skills, post-install hook
- **Contact name resolution** in `search_messages` and `get_conversation` — search by name ("Mom") instead of phone number via `resolveByName()` reverse AddressBook lookup
- `IMESSAGE_SAFE_MODE` environment variable added to MCP Registry `server.json`
- Uninstall section in README
- Demo GIFs for light and dark mode with `<picture>` tag
- `CHANGELOG.md` covering all versions
- Ready-to-paste JSON config snippet in `doctor` output

### Fixed
- **Safe Mode gaps**: `get_message_effects`, `get_reactions`, `list_attachments`, and `get_edited_messages` now wrap `getMessageText()` with `safeText()` — previously leaked message bodies when `IMESSAGE_SAFE_MODE=1`
- Node.js badge in README (static "18+" instead of broken dynamic badge)
- Single-line JSON in README expanded to multi-line for readability

### Changed
- SECURITY.md updated to reference GitHub Security Advisories (was already correct, verified)

## [1.2.1] - 2026-02-24

### Changed
- **README overhaul**: collapsible setup sections for 8 clients, inline code blocks, restructured install flow
- Version bump across `package.json` and `server.json`
- `server.json` description shortened to 100 chars for MCP Registry compliance
- Real demo GIF added to README

## [1.2.0] - 2026-02-24

### Added
- **Safe Mode** (`IMESSAGE_SAFE_MODE=1`): redacts all message bodies, returns only metadata (counts, dates, names)
- `isSafeMode()` and `safeText()` functions in `db.ts`
- `safeText()` applied to `search_messages`, `get_conversation`, and other text-returning tools
- 5 safe mode tests (33 total)
- Safe Mode documentation in README and `help` tool
- **MCP Registry listing** via `server.json` (`io.github.anipotts/imessage-mcp`)
- Collapsible client setup sections in README
- Demo screenshot (iMessage-style conversation preview)

### Removed
- `marketplace.json` (replaced by `server.json` for MCP Registry)

## [1.1.1] - 2026-02-24

### Added
- **CI pipeline**: GitHub Actions workflow for automated testing
- **28 tests** across 3 test files covering db, helpers, and security
- ISO date validation helper (`isoDateSchema`)
- DRY version management
- README trust sections (Privacy & Security, How It Works, Requirements)

## [1.1.0] - 2026-02-24

### Added
- **Smart spam filtering**: `repliedToCondition()` only includes contacts you've replied to; opt out with `include_all: true`
- **Two-pass search**: text column (fast SQL LIKE) + attributedBody extraction (JS scan up to 10K rows) for complete results on macOS 14+
- **Contact name resolution** from macOS AddressBook (`lookupContact()`, `resolveFromAddressBook()`)
- `resolve_contact` tool for fuzzy-matching names, phones, and emails
- MCP `instructions` hint in server metadata
- Registry metadata (keywords, engines, repository)
- README badges (npm, downloads, license, TypeScript, MCP, CI, Node)
- Multi-client setup docs (Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, VS Code, Cline, JetBrains, Zed)
- `attributedBody` text extraction for macOS Sonoma+ messages with NULL `text` column

### Fixed
- Search now includes sent messages in spam filter (was excluding `is_from_me = 1` results)

## [1.0.0] - 2026-02-24

### Added
- **25 MCP tools** across 9 categories:
  - Messages: `search_messages`, `get_conversation`
  - Contacts: `list_contacts`, `get_contact`, `resolve_contact`
  - Analytics: `message_stats`, `contact_stats`, `temporal_heatmap`
  - Memories: `on_this_day`, `first_last_message`
  - Patterns: `who_initiates`, `streaks`, `double_texts`, `conversation_gaps`, `forgotten_contacts`
  - Wrapped: `yearly_wrapped`
  - Groups: `list_group_chats`, `get_group_chat`
  - Attachments: `list_attachments`
  - Reactions/Receipts/Threads/Edits/Effects: `get_reactions`, `get_read_receipts`, `get_thread`, `get_edited_messages`, `get_message_effects`
  - System: `help`
- **Read-only** SQLite access with `readonly: true` and `query_only = ON`
- **Parameterized queries** — no SQL string interpolation
- `readOnlyHint: true` annotations for MCP client auto-approval
- **CLI commands**: `doctor` (setup diagnostics) and `dump` (JSON export)
- `db.ts`: database layer with Apple epoch conversion, `attributedBody` binary parser, `getMessageText()` fallback
- `contacts.ts`: AddressBook resolver with phone digit normalization and email lookup
- `helpers.ts`: pagination, clamping, date validation, result formatting
- Project scaffolding: TypeScript 5.x, ESM, `better-sqlite3`, `@modelcontextprotocol/sdk`, `zod`
