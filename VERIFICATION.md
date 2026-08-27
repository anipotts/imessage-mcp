# verification

This report contains only synthetic, aggregate, or redacted evidence. It retains no live message text, contact values, database paths, tokens, or screenshots.

Last updated: 2026-08-27

## release state

| release | state | evidence boundary |
| --- | --- | --- |
| `1.3.1` | published and verified | npm `latest`, GitHub Release, and MCP Registry agree; a fresh public install reproduced fixes for issues #5 and #6 before they closed |
| `2.0.0-beta.1` | tagged, not published | npm rejected the relative tarball argument before upload; the signed tag and failed workflow remain immutable historical evidence |
| `2.0.0-beta.2` | published and verified | npm `next`, MCP Registry, and an immutable GitHub prerelease agree on the signed evidence lineage and exact package |
| `2.0.0-beta.3` | release subject | npm `next`; current public availability is authoritative at npm, MCP Registry, and the immutable GitHub release |
| `2.0.0-rc.1` | not started | requires beta acceptance with no known security, privacy, attribution, completeness, or installation blocker |
| `2.0.0` | blocked by design gate | requires an unchanged release candidate to pass the seven-day canary |

## `2.0.0-beta.3` release evidence

The beta.3 source repairs the validated cached-watermark snapshot race, vanilla installation graph, CLI discovery, privacy-first onboarding, untrusted-archive guidance, client namespace, and cross-surface release consistency. Publication is fail-closed unless the signed evidence commit contains a complete exact-revision scan with zero findings and the protected workflow re-verifies the package, provenance, npm, MCP Registry, GitHub release, and tag subjects.

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
| fixture suite | 111 tests passed, covering seven-tool semantics, privacy, database lineage, immutable release controls, source aliasing, decoder safety, lifecycle freshness, and package tamper rejection |
| package | 129-file allowlisted tarball passed metadata, doctor, stdio MCP, authenticated HTTP, named-client, and installed dependency-graph checks |
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

The release-authoritative standard scan covered the exact 81-file source revision and reported zero findings. Protected workflows then verified the signed direct-child evidence, exact package bytes, secret scan, CodeQL results, package contents, public provenance, and downstream metadata before completing publication.

The 2.0 rebuild repaired the validated classes found at the original `c911b17` baseline: transport authentication and exposure, privacy leakage, incorrect joins and attribution, pagination and date semantics, reaction and receipt state, contact ambiguity, resource bounds, private public assets, unsafe legacy decoding, mutable release evidence, and shared watcher/session state.

Aggregate mode is deterministic identity-free redaction. It is not differential privacy or a formal anonymity system. The MCP client controls retention and processing after a permitted result crosses the server boundary.

No stable release claim will use the word complete while a known security or data-correctness defect remains.

## performance gates

The mixed-service one-million-message synthetic fixture passed on macOS 26.5 arm64 with Node 24.19.0:

| measurement | result | gate |
| --- | ---: | ---: |
| fixture construction | 4.013 s | informational |
| bounded startup | 7.725 s | informational |
| `server_status` | 3 ms | under 1 s |
| `list_conversations` | 12 ms | under 1 s |
| initial `sync_messages` cursor | 1 ms | under 1 s |
| complete cold index | 22.511 s | under 60 s |
| warm substring search | 6 ms | under 2 s |
| one-character substring search | 97 ms | under 2 s |
| two authenticated HTTP clients | 22 ms | stable and under 2 s |
| index memory | 355,192,832 bytes | at or below 536,870,912 bytes |
| process RSS delta | 560,545,792 bytes | informational |

The bounded live archive gate passed all seven tools with zero aggregate probe leakage. Cold complete search took 61.981 seconds; `server_status` took 59 ms and `list_conversations` took 9 ms. The fixed million-message fixture owns the 60-second index target. Live archives use the 90-second cold-request ceiling.

## client and transport gates

Codex, Claude Desktop, Claude Code, and Cursor configuration shapes passed with isolated settings against the installed tarball. Stdio and authenticated stateless HTTP exercised all seven tools. Active user configuration remained untouched.

No Tailscale Serve route was created. Endpoint mutation requires separate approval.

## unsupported behavior

Certification excludes iPhone backup manifests, Linux, containers, Docker, public-internet HTTP, Tailscale Funnel, OAuth, multiple client tokens, persistent decoded-body indexes, semantic search, watchers, stateful sessions, old edited text, recovered unsent text, removed-reaction history, every send capability, and adversarial database-path replacement by another process running as the same macOS account.

Stable promotion remains blocked until a public release candidate exercises every tool, privacy mode, service family, transport, source mode, and named client for seven unchanged days.
