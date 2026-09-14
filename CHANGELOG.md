# changelog

this file follows [keep a changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning.

## 2.1.0

### fixed

- one-to-one chats were reported as groups on current macOS, which writes a `group_id` on every chat. conversation kind now follows Apple's `chat.style` (45 one-to-one, 43 group) and only falls back to `group_id` and a display name when style is missing or unrecognized. `list_conversations` with `kind: "direct"` returned nothing before this; response-time analytics also skipped those chats.

### changed

- prompts take no inputs, so choosing one from a client's prompt menu starts immediately instead of opening a form. `catch_up` and `draft_reply` find who is waiting on you themselves; `recap` replaces `who_said`, which only worked with a typed phrase.
- the desktop bundle's two settings are optional with defaults, so Claude Desktop enables the extension right after install instead of waiting for Configure.
- the readme leads with the one-click desktop install through a stable `releases/latest/download` link.

### added

- the search index starts building in the background after the first successful non-search call, so the first search does not pay for a cold build. a search that arrives mid-build waits for that build, and `server_status` answers from the other worker and reports `building`. set `IMESSAGE_WARM_SEARCH=0` to build only on first search.

## 2.0.1

### added

- an icon. the server announces it in the mcp handshake (`serverInfo.icons`, with a title and website), the desktop bundle carries it at every size claude desktop draws, and the mcp registry entry points at it, so clients show the same mark everywhere.

### changed

- ci and security runs on `main` are never cancelled by a later push or schedule, and release polls wait up to five minutes for npm, the registry, and attestations.

## 2.0.0

### added

- `imessage-mcp setup` and `imessage-mcp uninstall` register and remove the server for claude, codex, desktop, and cursor, with a timestamped backup of every configuration file they rewrite.
- `doctor --fix` repairs the generated key files and their modes.
- the reference key and the database identity are generated on first run, so nothing has to be made by hand before the first connection.
- titles and output schemas on all seven read-only tools.
- prompts for the common history questions.
- a claude code plugin marketplace entry.
- an optional `from_me` filter on `search_messages`, so a search can be limited to what you sent or to what you received without paging the whole result set.
- a `search_index_capacity` check in `doctor`, so an archive too large for the in-memory search ceiling is reported before the first search pays for a cold build and fails with `INDEX_TOO_LARGE`.
- an mcpb bundle attached to every release, launched through its own manifest on Apple Silicon and Intel runners before it ships, and carrying only the two Mac sqlite binaries.
- `npm run preflight`, the one maintainer command that runs everything a release needs, including the bounded live parity check that CI cannot run.

### changed

- one client name, `imessage`, in every documented configuration and in `.mcp.json`.
- every successful tool result now carries the serialized json of its structured content in the first text block, with the short human summary after it, so a client that reads only `content` still receives the whole result.
- node 22 or newer, on macos 14 or newer.
- releases are driven by a `v<version>` tag: the tagged revision re-runs `npm run verify` and the million-message performance gate, gitleaks, and codeql, then publishes the packed tarball to npm with provenance over github oidc, updates the mcp registry, and publishes an immutable github release.

## 2.0.0-rc.2 and earlier

prerelease notes live with their tags in [github releases](https://github.com/anipotts/imessage-mcp/releases).
