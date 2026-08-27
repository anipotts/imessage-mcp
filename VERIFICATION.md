# verification

This report contains only synthetic, aggregate, or redacted evidence. It does not retain message text, contact values, database paths, tokens, or screenshots from a live archive.

Last updated: 2026-08-26

## release state

| release | state | evidence boundary |
| --- | --- | --- |
| `1.3.1` | published and verified | npm `latest`, GitHub release, and MCP Registry agree on `1.3.1`; the public tarball reproduced the attributed-body and contact fixes before issues #5 and #6 closed |
| `2.0.0-beta.1` | tagged, not published | all exact-revision prepublication gates passed, but npm rejected an ambiguous relative tarball argument before upload; the signed tag and failed workflow remain immutable evidence |
| `2.0.0-beta.2` | release candidate, not yet published | carries identical runtime code with a corrected explicit local tarball path and must repeat the exact-revision scan, attestation, package, client, and public-artifact gates |
| `2.0.0-rc.1` | not started | requires every beta gate and public prerelease verification |
| `2.0.0` | blocked by design gate | requires a seven-day release-candidate canary; it cannot be promoted on the beta implementation day |

## current local evidence

| surface | result |
| --- | --- |
| host | macOS 26.5 arm64 |
| supported Node matrix | Node 22.22.3, 24.19.0, and 26.7.0 each passed the full local `npm run verify` gate |
| TypeScript | green with `tsc --noEmit` |
| fixture suite | 110 tests green, including live-source alias rejection, canonical doctor WAL reporting, lifecycle freshness, inode replacement, source budgets, privacy, decoder safety, immutable workflows, seven-tool semantics, and stable-package tamper rejection |
| attributed-body decoding | 375 of 375 stratified live iMessage, SMS/MMS, and RCS bodies exactly matched Apple's populated text; attachment placeholders were excluded; no private values emitted |
| built worker runtime | seven tools registered; deadlines wait for worker and native-child termination before a slot is reused |
| synthetic screenshots | four PNGs regenerated from a temporary synthetic database and fake home path |
| dependency and secret audit | zero vulnerabilities reported on Node 22, 24, and 26 full gates; a redacted whole-working-tree Gitleaks scan found no leaks |
| installed package | packed tarball passed doctor, stdio MCP, package-content, Codex, Claude Desktop/Code, and Cursor isolated configuration checks |
| transports | real MCP requests passed over stdio, authenticated stateless loopback HTTP, and a local Tailscale Serve-style reverse-proxy simulation |
| exact beta.1 candidate | signed source `a7ede194e6f20436cc08e27621cbfed825969684` passed the full local gate on Node 22, 24, and 26; its signed evidence child `49b196bc5b3b8c1a80c7f35aac86bd2bcee43404` passed all 17 pull-request checks plus protected security attestation run `33027523175` |
| trusted publishing | npm accepted the exact `anipotts/imessage-mcp`, `release.yml`, `npm-release` OIDC tuple with `npm publish` permission; no long-lived npm token is used |
| public 1.3.1 package | release run `33021458297` published with provenance from signed commit `e0ab712c79869cc0e484e019dbbc1a123dce2628`; a fresh macOS 14/Node 22 registry install reported 25 tools, exact attributed-body decoding, and rejected empty contact queries |

## service and schema matrix

| capability | synthetic fixture | bounded live check | status |
| --- | --- | --- | --- |
| iMessage | covered | exact decoder parity sampled; 41 visible records across 9 chats matched Messages.app in both directions | automated and bounded UI comparison green |
| SMS and Apple-represented MMS | covered | detected and exact decoder parity sampled | automated green; bounded UI sample did not expose this family |
| RCS | covered | detected and exact decoder parity sampled | automated green; bounded UI sample did not expose this family |
| unknown service values | covered | synthetic capability and filter paths | automated green; live sample unavailable |
| edits and retractions | covered | bounded live probe and visible-state invariants | automated green; no representative UI event retained |
| reactions and receipts | covered | bounded live probe and current-state folding | automated green; no representative UI event retained |
| group events and replies | covered | bounded live probe and typed timeline behavior | automated green; no representative UI event retained |

Android-originated SMS, MMS, and RCS are supported only when those conversations already appear in Apple Messages on the tested Mac.

## privacy matrix

Automated assertions cover full, redacted, and aggregate results, including warnings, errors, summaries, stderr diagnostics, attachment aliases, filenames, paths, search scopes, and cursor behavior through installed stdio and authenticated HTTP packages.

Aggregate mode is deterministic identity-free redaction. It is not differential privacy or a formal anonymity system.

## security

A sealed baseline scan at commit `c911b17` validated 15 findings across privacy, transport, resource bounds, packaging, public assets, optional schemas, and legacy decoding. Those classes were repaired during the 2.0 rebuild.

The latest pre-remediation whole-working-tree scan used scan `3212fa03-e2da-4947-b22a-a1f7b6afbe50`, snapshot `codex-security-snapshot/v1:sha256:7b1189f278de89b4a0facce221b46f512d5ac24e8d8eb380ed8863ad365f3882`, and reported nine release blockers. Remediation makes the signed evidence commit carry the sealed canonical scan files themselves, validates their exact Git-revision target, hashes, zero-finding state, and complete coverage before attesting the package, and re-verifies the attested tarball immediately before npm publication. Stable promotion now requires a protected canary attestation that verifies npm's signed RC provenance, source commit, public package digest, transparency-log integration time, and successful release workflow; certifies every exercise; restricts stable source to a direct metadata-only child; checks operational metadata with exact field-level version transforms; and byte-compares every other packaged file. The rebuild also uses an exact package allowlist, removes duplicated sync cursor state, authenticates `chat_lookup` relationships, rejects unsupported SQLite body types, recognizes only certified legacy archive frames, and budgets schema discovery before materialization. A fresh sealed scan of the exact committed tree remains required before beta publication.

Standard scan `f4327f9d-f49b-497d-9927-2ef1b2f8664e` completed with zero reportable findings and complete coverage of signed revision `dd73cceae1d24674f470efc52eb10343ca2295af`. Its signed evidence commit `b541c6216cea0f3c3fdd37f6a872ea44025ec9bb` proved the intended scan-to-package chain. Remote CI then detected a newly published transitive dependency patch and a CodeQL bearer-token finding, so that bundle is historical evidence and cannot authorize the repaired candidate.

Standard scan `f4a16214-e26d-42f0-b65e-57d21291d39f` completed with zero reportable findings and complete 78-of-78-file coverage of signed revision `bd83154124108e0e2dc8497a77d164842d4e50c1`. Follow-up review then tightened HTTP concurrency placement, CodeQL integration, scan-producer pinning, and read-only documentation at `4a569c777c052e41e61dcff200b8eaf0d751d509`, so this scan is also historical. The release-authoritative result must be the canonical `security/scan` bundle in a signed direct child of the final source commit; the protected workflow verifies that relationship before publication.

Standard scan `7d588236-f899-4bf8-840a-97be019a2bd1` covered all 78 files at signed revision `2fffb0d6c379d85c81693547bed3798651166601` and found one release blocker: a copied-database alias could resolve to the live Messages database after lexical source classification. The repaired source derives the trusted live path from the OS account, compares canonical main-file and WAL identities before SQLite opens, rejects symlinked or non-regular copy WAL sidecars including dangling links, and preserves ordinary copies plus aliases to non-live copies. Synthetic regressions cover direct and parent symlinks, hardlinks, future WAL targets, ordinary copies, and missing paths. That scan is historical and cannot authorize publication; a fresh zero-finding scan of the final signed source remains required.

Standard scan `981aad1d-eb9a-476b-8f20-45dae174ab18` completed with zero findings and complete 78-of-78-file coverage of signed revision `5f35345a1b807c2eddac72be277b5dc9ad1e457f`. Its stable copy-to-live database and WAL alias controls passed independent review. That review also identified a non-security diagnostic mismatch: for a supported symlink-selected copy, `doctor` described the lexical WAL sibling instead of the canonical WAL SQLite read. The candidate now derives the displayed WAL check from the successfully validated canonical database path and includes a live-WAL synthetic regression. The zero-finding scan is therefore historical; the final signed source must repeat it before publication.

Standard scan `e4eff6f1-9192-4fb3-a085-e3c4d9a83bc4` completed with zero findings and complete 78-of-78-file coverage of signed revision `a7ede194e6f20436cc08e27621cbfed825969684`. Signed evidence child `49b196bc5b3b8c1a80c7f35aac86bd2bcee43404` contains the canonical scan bundle, and protected workflow run `33027523175` attested both the evidence and exact package bytes. Release run `33028109456` repeated the package, performance, secret, and CodeQL gates, then failed before publication because npm parsed `release-artifact/imessage-mcp-2.0.0-beta.1.tgz` as a GitHub shorthand instead of a local file. Beta.2 changes the release argument to an explicit `./release-artifact/...` path; its own direct-child scan and attestation remain mandatory.

No stable claim will use the word complete while a known security or data-correctness defect remains.

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

## client and transport gates

Codex, Claude Desktop, Claude Code, and Cursor configuration shapes passed with isolated settings against the installed tarball. Stdio and authenticated stateless HTTP exercised all seven tools. A local reverse proxy verified the documented Tailscale Serve boundary, including forwarded TLS metadata plus allowed Host and Origin values. No Tailscale Serve route was created because endpoint mutation requires separate approval.

Messages.app was already running for the bounded manual comparison. Without navigating or retaining screenshots, 41 exact visible records across 9 chats matched in both directions; no message values or identities left the process. The selected UI sample exposed one service family, while the automated live decoder gate covered iMessage, SMS/MMS, and RCS. Unified Contacts was available, and aggregate contact resolution completed without identity leakage.

The bounded live archive gate passed all seven tools with zero aggregate probe leakage. Exact attributed-body parity matched 375 of 375 sampled iMessage, SMS/MMS, and RCS rows. Cold complete search took 61.981 seconds; `server_status` took 59 ms and `list_conversations` took 9 ms. The fixed one-million-message fixture owns the 60-second index SLA, while the growing live archive is bounded by the 90-second cold-request ceiling. Only aggregate counts and timings were emitted.

The stable workflow is implemented and tested but cannot produce its protected attestation until `2.0.0-rc.1` has been public and fully exercised for seven days. Stable release gate: blocked pending that future canary.

Prerelease release gate: passed. The tag remains mechanically blocked until exact-revision remote checks pass and its signed direct-child scan bundle has zero findings, complete repository coverage, the expected producer version, and a protected GitHub attestation.

## unsupported behavior

The certification excludes iPhone backup manifests, Linux, containers, Docker, public-internet HTTP, Tailscale Funnel, OAuth, multiple client tokens, persistent decoded-body indexes, semantic search, watchers, stateful sessions, old edited text, recovered unsent text, removed-reaction history, every send capability, and adversarial database-path replacement by another process running as the same macOS account.
