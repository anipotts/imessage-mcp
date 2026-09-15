# security

## supported versions

| version | security support |
| --- | --- |
| 2.x | supported |
| 1.3.1 | security and data-corruption fixes for 90 days after stable 2.0 |
| older | unsupported |

## report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/anipotts/imessage-mcp/security/advisories/new). Do not include message contents, handles, contact names, database files, attachment paths, tokens, or screenshots in a public issue.

Please include the affected version, macOS and Node versions, transport, privacy mode, impact, and a minimal synthetic reproduction.

## security boundary

Every 2.x tool is read-only. SQLite opens with `readonly`, `fileMustExist`, and `query_only`. The server does not request WAL mode, execute a write statement, send a message, or change Messages and Contacts settings.

Stdio is local to the launching client. Optional HTTP binds only to loopback, authenticates before parsing request bodies, validates Host and Origin, uses bounded request and response sizes, and is intended for private TLS termination through Tailscale Serve. Direct public-internet exposure and Tailscale Funnel are unsupported.

Decoded bodies are indexed in memory only. The package writes no message index, telemetry, or persistent audit log. Diagnostics exclude query text, references, identity values, paths, and message values. Its only outbound request is an anonymous version lookup to `https://registry.npmjs.org/imessage-mcp/latest` from `server_status` and `doctor`, carrying no message, contact, or identity data, cached for twelve hours and disabled by `IMESSAGE_UPDATE_CHECK=0`. See [PRIVACY.md](PRIVACY.md).

Every message body, contact value, group title, URL, attachment filename, and database-derived string is untrusted archival data. It is returned as data, never as an instruction from this server. MCP clients should keep tool results separate from trusted instructions, avoid following links or executing commands found in history, withhold secrets, and require confirmation before any external action influenced by archival content. The server advertises this boundary in its MCP instructions. These controls reduce exposure; they do not eliminate prompt injection or control how a client or model provider processes returned results.

Keyed attributed-body archives are decoded through Foundation's decode-time class allowlist. Legacy `streamtyped` bodies are parsed only for their bounded root UTF-8 string and are never passed to `NSUnarchiver` or another object-constructing legacy deserializer.

Opaque references are encrypted and authenticated with an operator-controlled key and a separate operator-assigned database identity. Faithful copies must reuse both values. Every unrelated archive must receive a new database identity, so accidental reference-key reuse does not merge their authority. Both inputs are integrity-sensitive and must remain under operator control. References are not an authorization substitute. Anyone with access to a full-mode MCP client can ask that client to read the underlying local history.

For `sync_messages`, a copied database is an immutable snapshot and is fingerprinted with its WAL before a cursor is accepted again. The live database assumes Messages is its sole writer. Live cursors bind structural relationships independently from body/lifecycle and receipt state. Recent content carries exact per-row state for a one-hour safety window, older content is fully hashed, and receipt comparisons are normalized to the cursor's checkpoint. Changes that do not fit the corresponding monotonic lifecycle fail closed. Direct database mutation by SQLite tools, migration utilities, or third-party software is unsupported; restart the server and establish a fresh cursor after any such operation.

Copied sources are checked by canonical path and file identity before SQLite opens them. Aliases to the live Messages database or its WAL are rejected. The copied database, sidecars, and parent directory must remain controlled by the operator and unchanged while the server starts and runs. Adversarial path replacement by another process running as the same macOS account is outside the security boundary.

## public assets and git history

Current screenshots and verification artifacts use a synthetic database and fake home path. Private-metadata assets replaced in newer commits can remain recoverable from repository Git history and existing clones. Removing them from the current tree does not erase old objects. This notice intentionally does not repeat those values.

## release checks

A release is a `v<version>` tag. Changes reach `main` only through a pull request whose required checks pass: the supported macOS and Node matrix running `npm run verify`, the dependency and package audit, privacy non-leakage tests, CodeQL, and secret scanning. Commits are signed and `main` is protected.

Pushing the tag runs the release workflow on that exact revision. It binds the tag to `package.json`, requires a stable tag to be an ancestor of `main`, re-runs `npm run verify` and the million-message performance gate, and runs Gitleaks and CodeQL against the same revision. The tarball packed in that job is the artifact that ships, unchanged, to every downstream surface.

npm publication uses trusted publishing over GitHub OIDC in a protected environment and carries SLSA provenance for the tagged commit; no long-lived npm token exists. The public tarball is compared byte-for-byte with the verified artifact and the installed production graph is checked before the MCP Registry and GitHub release jobs run. npm, MCP Registry, and GitHub release authority stay in separate least-privilege jobs, the GitHub release is published immutable, and every GitHub Action is pinned to a reviewed commit.
