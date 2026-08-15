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

Decoded bodies are indexed in memory only. The package writes no message index, telemetry, or persistent audit log. Diagnostics exclude query text, references, identity values, paths, and message values.

Keyed attributed-body archives are decoded through Foundation's decode-time class allowlist. Legacy `streamtyped` bodies are parsed only for their bounded root UTF-8 string and are never passed to `NSUnarchiver` or another object-constructing legacy deserializer.

Opaque references are encrypted and authenticated with an operator-controlled key plus stable archive anchors scoped to one database lineage. Faithful copies must reuse that key; unrelated archives should use distinct keys and are independently rejected when their anchors differ. References are not an authorization substitute. Anyone with access to a full-mode MCP client can ask that client to read the underlying local history.

For `sync_messages`, a copied database is an immutable snapshot and is fingerprinted with its WAL before a cursor is accepted again. The live database assumes Messages is its sole writer. Live cursors bind structural relationships independently from body/lifecycle and receipt state. Recent content carries exact per-row state for a one-hour safety window, older content is fully hashed, and receipt comparisons are normalized to the cursor's checkpoint. Changes that do not fit the corresponding monotonic lifecycle fail closed. Direct database mutation by SQLite tools, migration utilities, or third-party software is unsupported; restart the server and establish a fresh cursor after any such operation.

## public assets and git history

Current screenshots and verification artifacts use a synthetic database and fake home path. Private-metadata assets replaced in newer commits can remain recoverable from repository Git history and existing clones. Removing them from the current tree does not erase old objects. This notice intentionally does not repeat those values.

## release checks

Public prereleases and stable releases require fixture and protocol correctness, privacy non-leakage tests, dependency audit, CodeQL, secret scanning, exact package-content inspection, a sealed security scan, provenance verification, and the platform/client/service matrix in [VERIFICATION.md](VERIFICATION.md). `release-status.json` is display state only. The sealed scan is bound through a signed evidence commit whose direct parent is the scanned revision and whose only changes are the canonical scan manifest, findings, and coverage files under `security/scan`. A protected workflow verifies that signature against an operator-controlled allowed signer, recomputes the canonical artifact hashes, requires an exact Git-revision target with zero findings and complete whole-repository coverage, and attests the exact commit, trees, version, evidence JSON, and tarball. Publication re-verifies those subjects immediately before npm. npm, MCP Registry, and GitHub release authority remain in separate least-privilege jobs. Every GitHub Action is pinned to a reviewed commit.

Stable publication is fail-closed until the protected `attest-canary.yml` workflow verifies npm's signed SLSA provenance, exact public release-candidate digest, source commit, successful release workflow, and any registry `gitHead` that is present. It uses npm's publication timestamp as the canary start, observes at least seven elapsed days, certifies every named exercise, and attests the result. Stable source must be the direct child of the canaried RC evidence commit and may change exactly the reviewed version and verification metadata. The workflow compares both tarballs and requires every other packaged byte to remain identical. The release workflow re-verifies that exact-sha attestation immediately before npm publication. Editable dates or checkboxes never authorize stable publication by themselves.
