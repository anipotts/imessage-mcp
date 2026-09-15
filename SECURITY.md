# Security

## Supported versions

| version | security support |
| --- | --- |
| 3.x | supported |
| 2.x | security fixes until 2027-03-15 |
| older | unsupported |

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/anipotts/imessage-mcp/security/advisories/new). Do not put message contents, handles, contact names, database files, attachments, tokens, or screenshots in a public issue. Include the version, macOS and Node versions, transport, privacy mode, the impact, and a minimal reproduction on synthetic data.

## What the server can do

- **Read only.** `chat.db` and the AddressBook databases are opened read-only with `query_only`. There is no write statement, no AppleScript, no Messages or Contacts automation, and no tool that sends, edits, reacts, or marks anything read.
- **The boundary is Full Disk Access.** macOS decides whether the app that launched the server can read Messages. The server reads nothing that app could not read directly, and it cannot grant itself access.
- **Network.** stdio by default. The only outbound request is the optional version check, an anonymous GET to `registry.npmjs.org/imessage-mcp/latest` whose response is validated as a version string and bounded in size; `IMESSAGE_UPDATE_CHECK=0` turns it off.
- **HTTP transport.** Binds to 127.0.0.1 only, authenticates the bearer token and checks Host and Origin before reading a request body, and bounds request and response sizes. It is meant for private access through Tailscale Serve. Public exposure and Tailscale Funnel are unsupported.

## The search index cache

The index holds decoded message text, so it is encrypted on disk:

- The file lives in `~/Library/Caches/imessage-mcp` with mode 0600 in a 0700 directory, written atomically.
- It is sealed with AES-256-GCM. A fresh salt and nonce are drawn for every write, and the whole header is authenticated.
- The key is derived with HKDF-SHA256 from the newest message in each of the most recently active conversations: their ROWIDs, guids, dates, sender ids, and direction. Those rows are read from `chat.db` each time, and the key is never stored.
- Opening the cache requires reading the current Messages database, which requires Full Disk Access. A backup or an old copy of the database lacks the newest rows. Revoking Full Disk Access also locks the cache.
- When those rows are deleted, the next start rebuilds the index. A restored index is compared with the live database before it answers, so a stale or replayed cache never returns deleted messages.
- **Limit:** with only a few active conversations, the key rests on rows a single counterparty's devices also hold. The cache protects against other local processes and stale backups, not against someone who holds that thread and can already read this file.
- `IMESSAGE_CACHE=0` keeps the index in memory. Deleting the directory is always safe.

## Attachments

`get_attachment` serves files the sender chose, so it is bounded:

- **Full mode only.** It works only at the `full` privacy ceiling.
- **Path confinement.** The path must resolve, after symlinks, inside `~/Library/Messages/Attachments`.
- **Size limits.** Files above 25 MB, and images above 50 megapixels, are refused before any decoding.
- **Images.** They are converted by `/usr/bin/sips`, run without a shell under one 10-second deadline. The result is capped at 1600 px on the long edge, and every EXIF, XMP, ICC, IPTC, and comment segment is removed, including GPS coordinates.
- **Text.** Text files return at most 64 KB. Anything else returns metadata only; no PDF or document parser runs.

## Untrusted content

All message text, names, handles, group titles, URLs, filenames, and attachment text are archival data written by other people. The server tells clients so in its MCP instructions and marks every tool read-only. That reduces prompt-injection risk; it does not remove it. Clients should keep tool results separate from instructions and confirm any action influenced by them.

## Contacts

Names come from the AddressBook databases Contacts.app keeps under `~/Library/Application Support/AddressBook`, read under the Full Disk Access the server already needs. Contacts.framework is never called, so macOS shows no separate Contacts prompt. `--contacts none` turns names off.

## Releases

A release is a `v<version>` tag on a commit that reached protected `main` through a pull request with required checks. The release workflow verifies that tag, runs the tests, CodeQL and Gitleaks on the same revision, and publishes:

- to npm through trusted publishing, with provenance and no long-lived token;
- to the MCP Registry;
- as an immutable GitHub release, whose desktop bundle is signed with an Apple Developer ID certificate when one is configured.

Every GitHub Action is pinned to a reviewed commit.
