# issue 65: shared messages must not make an archive unreadable

observed: 2026-10-04. baseline: `origin/main` at `521c74175f8a729753a303c473d2954cd77dbce9`, published npm `3.2.0`. implementation is on the task branch `fix/conversation-membership`; it is not released.

## conclusion

this is a server data-model defect. a message can have more than one recorded chat membership without an explicit Apple lookup linking those chats. the server treated that valid shape as a fatal schema error before most tools applied their scope. the durable correction is to model message identity and conversation membership separately throughout listing, search, analytics and sync.

removing one assertion would restore some calls while corrupting counts and losing memberships elsewhere. combining every chat that shares a message would invent conversation links. the implementation preserves Apple's recorded relations, deduplicates records when counting globally, and makes multiplicity explicit in the API.

## report and source evidence

[issue 65](https://github.com/anipotts/imessage-mcp/issues/65) reports BoltAI, macOS 26.6.1 (25G76), Node 25.6.0 and package version “latest”. it does not supply exact installed package bytes, architecture, transport, privacy mode, source mode or a synthetic fixture. as inspected on october 4, npm `latest` and the newest GitHub release are `3.2.0`. the downloaded official npm tarball contains the exact failing guard in `dist/repositories/conversations.js`, so the defect is shipped code.

the downloaded npm tarball has SHA-256 `1b448db6e53cf98f8731a9a6021dba09c07d616c19b6f43605ff28abdd6b3f96`.

baseline source in `src/repositories/conversations.ts` has an archive-wide assertion that groups each message's joins by canonical component and rejects more than one component. git blame places the guard in commit `603d8201`, the august 11 2.0 rebuild, rather than a recent change specific to the reported macOS version.

this is an established archive shape: the imessage-exporter maintainer documented it on june 21, 2023 in [upstream issue 135](https://github.com/ReagentX/imessage-exporter/issues/135). its [diagnostics documentation](https://github.com/ReagentX/imessage-exporter/blob/develop/docs/diagnostics.md) explains retaining the message in every chat where Apple recorded it. this supports the interpretation of our assertion as mistaken. it does not prove what generated the reporter's particular rows.

no private Messages or Contacts data was read, copied or uploaded. all reproductions and verification used task-owned synthetic archives.

## reproduction and blast radius

starting with the existing synthetic fixture, add one recorded membership from message 1 to chat 3. chats 1 and 2 are already aliases linked by Apple; chat 3 is a separate component. there are now two canonical memberships, without any malformed schema or body.

| baseline operation | result |
| --- | --- |
| `list_conversations` | `UNSUPPORTED_SCHEMA` |
| `get_conversation` for unrelated chat 4 | same error through catalog labeling |
| `search_messages` | same error before building or refreshing the index |
| global `analyze_communication` | same error before metric evaluation |
| `sync_messages` | same error through search/index setup |
| `server_status` | succeeds |
| exact-handle `resolve_contact` | succeeds |
| `get_attachment` metadata | succeeds |
| `doctor` | incorrectly reports supported schema and exits successfully |

strict and partial reads both fail. the assertion checks reaction and system rows as well as searchable user messages, so one such association can affect unrelated conversations. initialization, the MCP handshake and the request queue remain usable. “all tools” accurately describes the user's experience of core conversation operations, but the synthetic reproduction fails five of eight tools, not every tool.

there is no evidence that BoltAI, Full Disk Access or Node caused this exact membership error. the guard is reached only after SQLite reads succeed. the reporter's exact installation and archive still require a sanitized retry to confirm resolution on that machine.

## why existing verification missed it

an existing correctness test explicitly required rejection of this shape. it encoded the product assumption instead of an independent correctness rule. a green OS/runtime matrix could only prove that the mistaken assertion ran consistently. `doctor` checked table/column compatibility and a coarse index capacity estimate, but did not characterize recorded memberships. it could report success while the five affected tools were unusable.

there were also downstream single-owner assumptions: search selected one conversation for a message, global analytics grouped by message plus conversation, and sync stored a minimum chat id and reinterpreted historical ids through the current graph. relaxing the guard alone would expose those errors.

## implemented design

`src/repositories/conversation-topology.ts` now owns the bounded canonical topology shared by the repositories and index. a message has zero or more recorded memberships. only explicit `chat_lookup` evidence joins aliases; shared message ids and participant similarity do not. dangling lookup references cannot create a canonical id for a deleted chat, and dangling message joins do not qualify a message as searchable.

| area | resulting behavior |
| --- | --- |
| catalog and timelines | separate unlinked conversations remain readable; duplicate raw joins do not duplicate a record within one component |
| search | one body/index row per message, a normalized message-to-conversation relation, all canonical `chat_ids`, and metadata from every recorded conversation |
| search refresh | changes in secondary conversation metadata, joins or lookup topology invalidate every affected message, including non-searchable sync state |
| global/contact analytics | unique records with valid membership within the requested scope, including retained retracted records; reaction/system totals and time distributions do not inflate with membership count |
| conversation sequence metrics | each recorded conversation retains its sequence; applied parameters state the counting unit and shared-membership policy |
| sync | full membership snapshots, additive membership-change events, prior ids, and history that is not rewritten through today's lookup graph |
| diagnostics | counts-only membership summary, observable stable build failures and cache capability/status, with uncontrolled exception text excluded |
| privacy | aggregate mode strips plural ids from nested states, scopes and errors; redacted mode preserves the established identity/content rules |

single-member search and sync results keep `chat_id` for compatibility. shared results expose only `chat_ids`, avoiding an arbitrary “primary” conversation; search adds plural labels. membership events have a null source timestamp because Apple does not timestamp these associations. the existing change sequence supplies observation order. available bodies, sender, service and receipt fields remain current-state projections, not historical snapshots. retained text from a currently retracted message is suppressed even when replaying an older creation or edit.

the index/checkpoint format is versioned. old checkpoints are rebuilt once; old sync cursors are rejected instead of resumed against a different history. clients must handle `DATABASE_CHANGED` by starting a new sync. explicit membership budgets, source cardinality limits, strict decoding and the in-memory ceiling remain enforced.

## additional concrete defects found

1. the SQLite statement wrapper did not finalize its native iterator when a consumer threw or broke early. a failed topology scan could retain a read lock and prevent later source repair. iterator cleanup now runs in `finally`, with tests that attempt a write from a separate connection after break, throw and explicit iterator return.
2. Node 25 lacks the SQLite serialize/deserialize APIs despite satisfying the package's numeric minimum. the old cache swallowed the resulting exception and rebuilt on each process start. Node 24.16.0 and 24.19.0 have the APIs. the [Node SQLite documentation](https://nodejs.org/api/sqlite.html#databaseserializedbname) also shows their separate introduction on the 26.x line. the implementation feature-detects both APIs, continues search from memory and reports the unavailable cache; it also surfaces checkpoint write failures. this is a separate runtime compatibility problem, not the cause of the membership error.
3. sync misclassified a system membership change as incoming and incomplete because it required a human sender. it now reads the live record kind. older created/edited events also exposed retained text from a currently retracted message; that content is now omitted without decoding. physical deletion previously used the original send date as its deletion time; disappearance now has an unknown/null time, while explicit recorded removal and retraction dates remain intact.
4. summing participants across shared components would wrongly reject two chats containing the same 600 participants under a 1000-participant limit. the hard fanout check now counts distinct participants for the message; an adversarial fixture verifies this.

## verification

final local verification on 2026-10-04, macOS 26.5, arm64:

| check | result |
| --- | --- |
| repository `npm run verify`, Node 24.16.0, bundle required | passed typecheck, 299 unit tests, 16 end-to-end tests, audit and pack dry-run |
| exact reporter runtime, Node 25.6.0, unit tests | 292 passed; 7 checkpoint-only tests skipped because the APIs are absent; fallback coverage passed |
| exact reporter runtime, Node 25.6.0, bundle required | 16 end-to-end tests passed |
| desktop bundle build | manifest valid; 2.3 MB unpackable artifact; all eight tools exercised over stdio/HTTP and required bundle coverage |
| dependency audit | zero vulnerabilities |
| npm package dry-run | 147 files, about 194 kB compressed; nothing published |
| one-million-message fixture with 100,000 shared records, Node 24.19.0 | all existing performance gates passed; every search-marker hit retained both memberships |
| final whitespace check | passed |

on an Apple M3 Pro, the mixed-membership performance run measured 34.936 s first build, 2.800 s cached start, 3 ms warm search, 2.884 s refresh after an unrelated join-date write, 6.049 s refresh after an edit, and 5.479 s listing. index memory was 504,938,496 bytes, about 481.5 MiB against the 512 MiB ceiling. the normalized membership table uses a compound primary key without a redundant rowid tree. larger bodies or substantially greater fanout can still hit the declared memory limit; these timings are synthetic local evidence, not guarantees for every archive.

targeted membership and cache tests cover unique search pagination, all search modes, secondary metadata refresh, join insertion/removal, explicit lookup merges/splits, reactions/system rows, offline cache catch-up, historical deletions, suppression of retracted content, privacy projection, overlapping participants and recovery from failed scans. separate tests verify old-format checkpoint rejection and the `DATABASE_CHANGED` response for a rebuilt sync log. independent source reviews found the participant estimate, dangling lookup, system classification and retraction issues before final verification; their fixes have synthetic regressions.

CI now includes Node 25 to exercise the real memory-only fallback and Node 24.16.0 to exercise the exact declared minimum, in addition to the existing macOS, Node and Intel package coverage. encrypted-checkpoint tests are conditional on the actual API capability; separate fallback tests run without those APIs.

## recommendations and remaining release work

ship this as a documented minor release because plural ids and an additional sync event are API behavior changes. recommend Node 24 LTS for CLI installations. do not tell users to modify their Messages database, delete duplicate records, grant broader access or repeatedly reinstall: those actions do not repair this source assumption.

retain a compatibility corpus organized by recorded relations and missing/optional capabilities, with invariants such as stable global counts when a second membership is added, all search memberships resolving to real conversations, fresh/refresh/cache parity and historical membership stability. every new Apple archive shape should become a synthetic fixture. test selection should follow data semantics as well as OS labels.

keep shared canonicalization in one module. broader conversion into a persistent message mirror or another dependency is unnecessary for this defect and would add sensitive storage, migration and lifecycle complexity. a bounded normalized relation inside the existing local index solves the known failure with less risk.

before publishing, complete the repository's release preflight on the exact release tree, including its owner-authorized read-only live parity check, review current branch protections and exact-head CI, and verify npm, bundle and registry artifacts after publication. obtain a sanitized retry from the reporter with the exact installed version and diagnostic check states. this investigation did not change the reporter's installation, post an issue reply, merge or publish anything.

the reporter's BoltAI/macOS 26.6.1 installation, Intel execution, and the newly extended hosted CI matrix were not exercised locally. private live parity remains an explicit release gate; no real archive was used to claim it passed.

no implementation can honestly guarantee every future Apple archive will work forever. Apple does not publish a stable Messages database contract, and malformed data, access failures and bounded-resource limits still exist. this change fixes the known systemic membership rejection, preserves correct downstream semantics and makes related failures diagnosable and recoverable.
