# verification

This report contains only synthetic, aggregate, or redacted evidence. It does not retain message text, contact values, database paths, tokens, or screenshots from a live archive.

Last updated: 2026-08-11

## release state

| release | state | evidence boundary |
| --- | --- | --- |
| `1.3.1` | gated, not yet published | local hotfix gates and GitHub Actions are green; npm trusted-publisher confirmation and public-tarball reproduction remain |
| `2.0.0-beta.1` | gated, not yet published | implementation and all seven named local gates are green; fresh sealed scan, manual Messages.app comparison, remote CI, and release-environment checks remain |
| `2.0.0-rc.1` | not started | requires every beta gate and public prerelease verification |
| `2.0.0` | blocked by design gate | requires a seven-day release-candidate canary; it cannot be promoted on the beta implementation day |

## current local evidence

| surface | result |
| --- | --- |
| host | macOS 26.5 arm64 |
| supported Node matrix | Node 22.22.0, 24.14.0, and 26.0.0 each passed the full local `npm run verify` gate |
| TypeScript | green with `tsc --noEmit` |
| fixture suite | 92 tests green, including lifecycle freshness, inode replacement, source budgets, privacy, decoder safety, immutable workflows, and seven-tool semantics |
| attributed-body decoding | 375 of 375 stratified live iMessage, SMS/MMS, and RCS bodies exactly matched Apple's populated text; attachment placeholders were excluded; no private values emitted |
| built worker runtime | seven tools registered; deadlines wait for worker and native-child termination before a slot is reused |
| synthetic screenshots | four PNGs regenerated from a temporary synthetic database and fake home path |
| dependency and secret audit | zero vulnerabilities reported on Node 22, 24, and 26 full gates; a redacted whole-working-tree Gitleaks scan found no leaks |
| installed package | packed tarball passed doctor, stdio MCP, package-content, Codex, Claude Desktop/Code, and Cursor isolated configuration checks |
| transports | real MCP requests passed over stdio, authenticated stateless loopback HTTP, and a local Tailscale Serve-style reverse-proxy simulation |

## service and schema matrix

| capability | synthetic fixture | bounded live check | status |
| --- | --- | --- | --- |
| iMessage | covered | detected and exact decoder parity sampled | automated green |
| SMS and Apple-represented MMS | covered | detected and exact decoder parity sampled | automated green |
| RCS | covered | detected and exact decoder parity sampled | automated green |
| unknown service values | covered | synthetic capability and filter paths | automated green; live sample unavailable |
| edits and retractions | covered | plaintext-free selected comparison still required | manual gate pending |
| reactions and receipts | covered | plaintext-free selected comparison still required | manual gate pending |
| group events and replies | covered | plaintext-free selected comparison still required | manual gate pending |

Android-originated SMS, MMS, and RCS are supported only when those conversations already appear in Apple Messages on the tested Mac.

## privacy matrix

Automated assertions cover full, redacted, and aggregate results. The final gate must also inspect warnings, errors, summaries, stderr diagnostics, attachment aliases, filenames, paths, search scopes, and cursor behavior through installed stdio and authenticated HTTP packages.

Aggregate mode is deterministic identity-free redaction. It is not differential privacy or a formal anonymity system.

## security

A sealed baseline scan at commit `c911b17` validated 15 findings across privacy, transport, resource bounds, packaging, public assets, optional schemas, and legacy decoding. Those classes were repaired during the 2.0 rebuild.

The latest pre-remediation whole-working-tree scan used scan `3212fa03-e2da-4947-b22a-a1f7b6afbe50`, snapshot `codex-security-snapshot/v1:sha256:7b1189f278de89b4a0facce221b46f512d5ac24e8d8eb380ed8863ad365f3882`, and reported nine release blockers. Remediation binds scan evidence to a signed tree-preserving commit, re-verifies the attested tarball immediately before npm publication, makes stable promotion fail closed until an immutable canary attestation exists, uses an exact package allowlist, removes duplicated sync cursor state, authenticates `chat_lookup` relationships, rejects unsupported SQLite body types, recognizes only certified legacy archive frames, and budgets schema discovery before materialization. A fresh sealed scan of the exact committed tree remains required before beta publication.

No stable claim will use the word complete while a known security or data-correctness defect remains.

## performance gates

The mixed-service one-million-message synthetic fixture passed on macOS 26.5 arm64 with Node 24.14.0:

| measurement | result | gate |
| --- | ---: | ---: |
| fixture construction | 4.008 s | informational |
| bounded startup | 7.443 s | informational |
| `server_status` | 716 ms | under 1 s |
| `list_conversations` | 10 ms | under 1 s |
| initial `sync_messages` cursor | 766 ms | under 1 s |
| complete cold index | 20.680 s | under 60 s |
| warm substring search | 4 ms | under 2 s |
| one-character substring search | 84 ms | under 2 s |
| two authenticated HTTP clients | 20 ms | stable and under 2 s |
| index memory | 301,166,592 bytes | at or below 536,870,912 bytes |
| process RSS delta | 373,719,040 bytes | informational |

## client and transport gates

Codex, Claude Desktop, Claude Code, and Cursor configuration shapes passed with isolated settings against the installed tarball. Stdio and authenticated stateless HTTP exercised all seven tools. A local reverse proxy verified the documented Tailscale Serve boundary, including forwarded TLS metadata plus allowed Host and Origin values. No Tailscale Serve route was created because endpoint mutation requires separate approval.

Messages.app was not launched for the manual comparison because it was closed and opening the last selected conversation can change unread or receipt state. That comparison remains a human gate. Contacts permission was unavailable during the live check; the documented handle-only fallback remained operational.

The bounded live archive gate passed all seven tools with zero aggregate probe leakage. Exact attributed-body parity matched 375 of 375 sampled iMessage, SMS/MMS, and RCS rows. Cold complete search took 57.852 seconds; metadata calls stayed under one second. Only aggregate counts and timings were emitted.

Prerelease release gate: blocked pending the fresh sealed scan, remote checks, release-environment setup, and manual Messages.app comparison.

## unsupported behavior

The certification excludes iPhone backup manifests, Linux, containers, Docker, public-internet HTTP, Tailscale Funnel, OAuth, multiple client tokens, persistent decoded-body indexes, semantic search, watchers, stateful sessions, old edited text, recovered unsent text, removed-reaction history, and every send capability.
