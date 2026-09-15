# changelog

this file follows [keep a changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning.

## 3.0.0

The first search of a session no longer rebuilds the index, nothing native is installed, and every MCP client installs the server the same way. Read-only remains a hard boundary.

### changed (breaking)

- tools take and return plain ids. `message_id`, `chat_id`, and `attachment_id` replace the encrypted `message_ref` and `conversation_ref` values, cutting several hundred characters per search hit. `get_conversation` takes `chat_id` and `around_message_id`, and `analyze_communication` takes `chat_id`.
- `sync_messages` is rebuilt on a change log kept by the search index. Changes now include `message_deleted` and carry a `seq`. Cursors from 2.x are rejected: call once without a cursor to start again.
- Node 24.16 or newer is required for `npx` installs. Claude Desktop brings its own Node.
- the `setup` and `uninstall` commands are removed, because each client has its own add command, shown in the README. `doctor` stays.
- the reference key and database identity files under `~/Library/Application Support/imessage-mcp` are no longer used, and `doctor` points out that the folder can be deleted. `--attachment-paths` is removed; use `get_attachment`.
- configurations written for 2.x say `imessage-mcp@2`; change them to `imessage-mcp@latest` to receive 3.x.
- contact names are read from the database Contacts.app keeps instead of through an AppleScript bridge, under the same Full Disk Access and without a separate Contacts prompt.

### added

- `get_attachment` returns one attachment. Images come back as a JPEG at most 1600 px on the long edge, with EXIF, GPS, and other metadata removed; text files as text; anything else as metadata. It works only in the `full` privacy mode.
- resources `imessage://conversations` and `imessage://conversations/{chat_id}` for clients that attach context.
- the search index is cached, encrypted, in `~/Library/Caches/imessage-mcp` with a key derived from the Messages database. On a 174,859-message archive the first search of a session dropped from 70 s to about 1.5 s. `IMESSAGE_CACHE=0` keeps it in memory.
- a search that arrives while the first index is still building returns `INDEX_BUILDING` with its progress, instead of waiting out the client's timeout. Every other tool keeps answering during the build.
- when Messages is blocked, errors and `doctor` name the app to grant Full Disk Access to when it is a recognized client.

### removed

- the native `better-sqlite3` module and its prebuilt binaries. Queries run through Node's built-in `node:sqlite`, and the desktop bundle carries no native code.
- the Foundation decoder process. Message bodies and edit histories are decoded in TypeScript; on a real archive it matched Foundation on every one of 179,788 bodies and every edit history that holds edits, about 300 times faster.
- `docs/`, `VERIFICATION.md`, and the per-release evidence files. Release evidence now lives in the GitHub release notes and CI.

## 2.2.0

### added

- `server_status` reports whether a newer release exists, with the bundle download and how to update, and `doctor` prints the same line. the lookup is one anonymous request to the public npm registry for this package's latest version, carrying no message, contact, or identity data, cached for twelve hours, and never holding a call up for more than 1.5 seconds. turn it off with `IMESSAGE_UPDATE_CHECK=0` or the new "Check for updates" setting in Claude Desktop.
- a privacy policy ([PRIVACY.md](PRIVACY.md)), linked from the README and the desktop bundle's manifest, and the bundle manifest now lists its seven tools, as Anthropic's extension directory requires.
- release builds sign the desktop bundle when an Apple Developer ID certificate is configured, and fail if the signature does not verify as trusted; without one, bundles ship unsigned as before.

### fixed

- without Full Disk Access, the server exited at startup, so Claude Desktop showed only a disconnected extension, and the CLI said the database "was not found". the server now stays connected, every tool answers with the exact System Settings path to fix it, and the next call after access is granted succeeds without a restart. tool errors also carry their message in the text content, for clients that do not show structured results.

### changed

- the README drops an out-of-date note about npm's 1.x line.

## 2.1.2

### fixed

- search rebuilt its whole index after almost every Messages write, because any commit (a read receipt, a delivery update) changed the database version it compared. on a real archive that turned a warm search back into a cold one of a minute or more. the index now keeps a fingerprint of its sources for every 256 message ROWIDs and every conversation, and a refresh re-indexes only the ranges whose fingerprint changed: edits, appends, deletions, retractions, renamed conversations, new participants, and attachment names. writes search never reads cost one fingerprint pass and no re-indexing. a refresh commits atomically, so a strict search that fails part way leaves the previous index intact, and a repaired row clears its partial warning without a rebuild.

## 2.1.1

### fixed

- a default search, conversation page, or sync failed with `DECODE_FAILED` on archives holding an empty attributed string, which Messages stores for app and edited messages without text. these archives have no attribute runs and were treated as malformed; they now decode to empty text, and every other malformed archive still fails closed.
- long pasted messages above 1 MiB could not be decoded, so search needed `allow_partial` on archives that have one. the attributed-body bound is now 4 MiB, shared by the native decoder, search, conversation pages, and sync; the per-page and per-sync source budgets grow to 8 MiB so such a body fits, while the decoder's per-call input and output budgets and the 3 MiB decoded-text cap are unchanged.

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
