# verification

This report contains only synthetic, aggregate, or redacted evidence. It retains no live message text, contact values, database paths, tokens, or screenshots.

Last updated: 2026-09-08 (local); new benchmark and demo timestamps are recorded in UTC.

## release state

| release | state | evidence boundary |
| --- | --- | --- |
| `1.3.1` | published and verified | npm `latest`, GitHub Release, and MCP Registry agree; a fresh public install reproduced fixes for issues #5 and #6 before they closed |
| `2.0.0-beta.1` | tagged, not published | npm rejected the relative tarball argument before upload; the signed tag and failed workflow remain immutable historical evidence |
| `2.0.0-beta.2` | published and verified | npm `next`, MCP Registry, and an immutable GitHub prerelease agree on the signed evidence lineage and exact package |
| `2.0.0-beta.3` | published and verified | npm `next`, MCP Registry, and the immutable GitHub prerelease agree on the signed evidence lineage and exact package |
| `2.0.0-rc.1` | previously published | npm `next` in the 2026-09-08 audit; immutable historical release |
| `2.0.0-rc.2` | local release preparation | targets npm `next`; not yet published; exact-source security evidence and provider checks remain required |
| `2.0.0` | planned from protected `main` | same exact-source CI and publication checks; reviewed runtime changes are allowed |

## RC.2 verification

`npm run verify` passed locally: 118 tests, all seven tools over source-tree stdio and authenticated HTTP, fresh installed-package doctor and stdio handshake, configuration-shape checks, metadata, and exact package contents. The final package contains 128 files and one 27,937-byte GIF; the previous packaged PNGs totaled 522,440 bytes. The installed production dependency graph is nine nodes, 38.8 MiB. The release preparation gate is separate from protected publication evidence.

The search-refresh deadline regression and both decoder ordering regressions failed before the fix and passed afterward. The deadline tests cover a rebuild finishing after 61 seconds, ordinary warm timeout at 30 seconds, and a fixed 90-second maximum even when a build notice arrives late. A real synthetic SQLite update verifies that the index rebuilds and returns fresh results during one session.

The installed test checks a JSON configuration shape and drives the installed server through the MCP SDK. It does not launch Codex, Claude Desktop, Claude Code, or Cursor. Source-tree protocol tests separately exercise stdio and authenticated HTTP. Named-client app testing is not claimed.

The [installed demo](docs/DEMO.md) passed doctor through npx in an empty temporary project, listed seven read-only tools, and searched synthetic Foundation-encoded text in full and aggregate modes. This is a fresh package installation on the current Mac, not a clean-machine test. A clean macOS first-use permission check remains to be performed.

The [million-message benchmark](docs/BENCHMARK.md) passed: 19.530 s cold, 11 ms warm, and 20.975 s after a database update. Machine details and the fixture procedure are included.

RC.2 uses one generated GIF in the package. The older PNG screenshots remain in Git and are excluded from npm. No real message data was accessed for this implementation.

## Historical evidence

The following platform and live-archive observations predate RC.2. They describe their named versions and do not certify this checkout or a new publication.

## `2.0.0-rc.1` release evidence

Beta acceptance completed against the public `2.0.0-beta.3` npm tarball in an isolated projectless Codex task with no repository context. Under Node 24, privacy-first `doctor`, MCP startup and handshake, all seven advertised tools, redacted status and conversation reads, an opaque-reference history read, fail-closed search plus documented partial recovery, and clean shutdown passed. The task emitted no private archive values and changed no Messages, Contacts, Full Disk Access, active client configuration, or Tailscale state.

Fresh bounded live parity on the RC source matched 375 of 375 attributed bodies across iMessage, SMS/MMS, and RCS. All seven tools passed with zero aggregate leakage and no private values emitted. The RC also makes intentional `--contacts none` doctor state a pass, removes redundant global-install guidance, and puts fail-closed search recovery in the first-run path.

Prerelease release gate: passed.

## `2.0.0-beta.3` release evidence

The beta.3 source repairs the validated cached-watermark snapshot race, vanilla installation graph, CLI discovery, privacy-first onboarding, untrusted-archive guidance, client namespace, and cross-surface release consistency. Publication is fail-closed unless the signed evidence commit contains a complete exact-revision scan with zero findings and the protected workflow re-verifies the package, provenance, npm, MCP Registry, GitHub release, and tag subjects.

Prerelease release gate: passed.

| evidence | result |
| --- | --- |
| fixture suite | 112 tests passed |
| package | 129 allowlisted files; 9 dependency nodes; 39.3 MiB vanilla installation; no extraneous packages |
| protocol | all seven tools passed over stdio and authenticated stateless HTTP; MCP instructions mark archival values untrusted and preserve read-only annotations |
| metadata | package, documentation, plugin, Registry manifest, client namespace, screenshots, verification record, exact version, and npm `next` channel agree |
| dependency audit | zero vulnerabilities at the high/critical release threshold |
| million-message fixture | 22.583 s cold index; 9 ms warm search; 90 ms one-character search; 23 ms two-client HTTP; 355,192,832-byte index |
| bounded live parity | 375/375 exact attributed bodies; iMessage, SMS/MMS, and RCS; seven tools; zero aggregate leakage; no private values emitted |

The release package is intentionally neutral about mutable publication timing. Public provider surfaces determine whether the immutable beta.3 subject is currently available.

## `2.0.0-beta.2` public evidence

| evidence | value |
| --- | --- |
| scanned source | signed commit [`4f68be639b4963538c2ff474ef82fe3b292130af`](https://github.com/anipotts/imessage-mcp/commit/4f68be639b4963538c2ff474ef82fe3b292130af) |
| signed evidence commit | [`adabc490e5f113ac58340d2dc816b0832b75b4c8`](https://github.com/anipotts/imessage-mcp/commit/adabc490e5f113ac58340d2dc816b0832b75b4c8), a direct child of the scanned source |
| release tag | signed annotated [`v2.0.0-beta.2`](https://github.com/anipotts/imessage-mcp/releases/tag/v2.0.0-beta.2) at the evidence commit |
| security scan | `fa2751e9-81f8-4821-a867-d58388af08a9`; 81 of 81 tracked files; zero findings |
| protected attestation | [run `33032406424`](https://github.com/anipotts/imessage-mcp/actions/runs/33032406424) |
| npm publication | trusted GitHub OIDC tuple `anipotts / imessage-mcp / release.yml / npm-release / npm publish`; no long-lived npm token |
| public reconciliation | [run `33035485709`](https://github.com/anipotts/imessage-mcp/actions/runs/33035485709) verified npm, MCP Registry, GitHub Release, and tag agreement |
| package SHA-256 | `2fc1ea8a47f2dfbd313d771824878790c7bba65d455e4418aa0e3afd344a64c9` |
| evidence SHA-256 | `2ee9531214efb88b1b5a0f8f35b65db6bf73c9a3d50498f558a05f06d6375d27` |

The npm package carries SLSA v1 provenance for the signed evidence commit. The GitHub prerelease is immutable. Its release attestation and both local assets passed `gh release verify` and `gh release verify-asset`.

The first beta.2 workflow published the attested package to npm, then stopped because its public-install check included development dependencies. The protected recovery workflow verified that exact failure state and the existing public package before publishing the same immutable version downstream. It contains no npm publish authority.

## platform and package matrix

| surface | result |
| --- | --- |
| supported matrix | GitHub-hosted macOS 14, 15, and 26 on Node 22, 24, and 26 passed `npm run verify` |
| architecture | arm64 full matrix; macOS 26 Intel installed-package smoke passed |
| fixture suite | 112 tests passed, covering seven-tool semantics, privacy, database lineage, immutable release controls, source aliasing, decoder safety, lifecycle freshness, and package tamper rejection |
| package | 129-file allowlisted tarball passed metadata, doctor, stdio MCP, source-tree authenticated HTTP, JSON configuration-shape, and installed dependency-graph checks |
| static and supply chain | TypeScript, CodeQL for Actions and JavaScript/TypeScript, Gitleaks, package signatures, and dependency audit passed; zero dependency vulnerabilities reported |
| transport | stdio and authenticated stateless loopback HTTP passed; a local reverse proxy exercised the documented Tailscale Serve boundary without creating a route |

## correctness and service coverage

| capability | synthetic fixture | bounded live check | status |
| --- | --- | --- | --- |
| iMessage | covered | exact decoder parity sampled; 41 visible records across 9 chats matched Messages.app in both directions | automated and bounded UI comparison passed |
| SMS and Apple-represented MMS | covered | detected and exact decoder parity sampled | automated live parity passed |
| RCS | covered | detected and exact decoder parity sampled | automated live parity passed |
| unknown service values | covered | no matching live sample | capability and filter paths passed |
| edits and retractions | covered | visible-state invariants probed | automated checks passed |
| reactions and receipts | covered | current-state folding probed | automated checks passed |
| group events and replies | covered | typed timeline behavior probed | automated checks passed |

Exact attributed-body decoding matched 375 of 375 stratified live iMessage, SMS/MMS, and RCS bodies. Attachment placeholders were excluded. Only aggregate pass/fail evidence left the process.

SMS, MMS, and RCS with Android users work only when those conversations already appear in Apple Messages on the tested Mac.

## privacy and security

Automated denial tests cover full, redacted, and aggregate results, including structured content, text summaries, warnings, errors, stderr diagnostics, attachment aliases, filenames, paths, search scopes, cursors, and references through installed stdio and HTTP packages.

The beta.3 release-authoritative standard scan covers the exact 82-file source revision and reports zero findings. Protected workflows must verify its signed direct-child evidence, exact package bytes, secret scan, CodeQL results, package contents, public provenance, and downstream metadata before publication.

The 2.0 rebuild repaired the validated classes found at the original `c911b17` baseline: transport authentication and exposure, privacy leakage, incorrect joins and attribution, pagination and date semantics, reaction and receipt state, contact ambiguity, resource bounds, private public assets, unsafe legacy decoding, mutable release evidence, and shared watcher/session state.

Aggregate mode is deterministic identity-free redaction. It is not differential privacy or a formal anonymity system. The MCP client controls retention and processing after a permitted result crosses the server boundary.

No stable release claim will use the word complete while a known security or data-correctness defect remains.

## performance gates

The mixed-service one-million-message synthetic fixture passed on macOS 26.5 arm64 with Node 24.20.0:

| measurement | result | gate |
| --- | ---: | ---: |
| fixture construction | 4.119 s | informational |
| bounded startup | 7.902 s | informational |
| `server_status` | 3 ms | under 1 s |
| `list_conversations` | 12 ms | under 1 s |
| initial `sync_messages` cursor | 1 ms | under 1 s |
| complete cold index | 24.037 s | under 60 s |
| warm substring search | 8 ms | under 2 s |
| one-character substring search | 102 ms | under 2 s |
| two authenticated HTTP clients | 29 ms | stable and under 2 s |
| index memory | 355,192,832 bytes | at or below 536,870,912 bytes |
| process RSS delta | 417,611,776 bytes | informational |

The bounded live archive gate passed all seven tools with zero aggregate probe leakage. Cold complete search took 61.165 seconds; `server_status` took 56 ms and `list_conversations` took 8 ms. The fixed million-message fixture owns the 60-second index target. Live archives use the 90-second cold-request ceiling.

## client and transport gates

A generic JSON configuration-shape check passed. It did not launch Codex, Claude Desktop, Claude Code, or Cursor. The installed tarball exercised stdio through the MCP SDK; source-tree protocol tests exercised stdio and authenticated stateless HTTP. Active user configuration remained untouched.

No Tailscale Serve route was created. Endpoint mutation requires separate approval.

## unsupported behavior

Certification excludes iPhone backup manifests, Linux, containers, Docker, public-internet HTTP, Tailscale Funnel, OAuth, multiple client tokens, persistent decoded-body indexes, semantic search, watchers, stateful sessions, old edited text, recovered unsent text, removed-reaction history, every send capability, and adversarial database-path replacement by another process running as the same macOS account.

Stable is prepared from protected `main` after the fixes and documentation are merged. Both release channels verify their own source and package, including the installed tarball, privacy, untrusted-archive boundary, client namespace, package contents, and first-run setup. CI and exact-source security evidence remain required before publication.
