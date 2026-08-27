# contributing

Use synthetic data only. Do not attach or commit Messages databases, WAL files, AddressBook data, message text, names, handles, group titles, URLs, filenames, attachment paths, opaque references, tokens, home-directory paths, or screenshots from a real archive.

## changes

1. Start from `main` and keep one focused change per commit.
2. Extend the generated fixtures in `tests/fixture.ts`; never use a live database in an automated test.
3. Run `npm ci`, `npm run verify`, and the relevant performance or protocol suite.
4. Describe the public behavior, supported macOS and Node versions, privacy ceiling, Contacts mode, and synthetic coverage in the pull request.

2.x remains read-only. Sending, modifying Messages or Contacts, persistent body indexes, public HTTP exposure, and live private-data fixtures are outside contribution scope.

## compatibility reports

Open a bug report with the exact package version, macOS version, Node version, Mac architecture, source mode (`live` or `copy`), service family, transport, privacy ceiling, Contacts mode, tool name, stable error reason, and sanitized timing. Include the relevant `doctor --contacts none --privacy aggregate --json` check names and pass/warn/fail states, not private values.

Provide the smallest synthetic reproduction you can. If a schema capability differs, list only table and column names needed to explain it. Never upload a database, attributed-body blob, contact record, client configuration, screenshot, or raw tool result. Report security issues privately through [SECURITY.md](SECURITY.md).

Any public comparison with Codex or another Messages integration must cite current primary evidence, include the observation date, and describe capabilities neutrally.
