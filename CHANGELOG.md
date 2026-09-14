# changelog

this file follows [keep a changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning.

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
- an mcpb bundle attached to every release.

### changed

- one client name, `imessage`, in every documented configuration and in `.mcp.json`.
- every successful tool result now carries the serialized json of its structured content in the first text block, with the short human summary after it, so a client that reads only `content` still receives the whole result.
- node 22 or newer, on macos 14 or newer.
- releases are driven by a `v<version>` tag: the tagged revision re-runs `npm run verify` and the million-message performance gate, gitleaks, and codeql, then publishes the packed tarball to npm with provenance over github oidc, updates the mcp registry, and publishes an immutable github release.

## 2.0.0-rc.2 and earlier

prerelease notes live with their tags in [github releases](https://github.com/anipotts/imessage-mcp/releases).
