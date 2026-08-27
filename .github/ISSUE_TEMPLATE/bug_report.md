---
name: Bug Report
about: Report a bug or unexpected behavior
title: ''
labels: bug
assignees: anipotts
---

**What happened?**
A clear description of the bug.

**Steps to reproduce**
1. ...
2. ...

**Expected behavior**
What you expected to happen.

**Environment**
- Exact package version:
- macOS version and architecture:
- Node version:
- Source mode (`live` or `copy`):
- Service family:
- Transport and privacy ceiling:
- Contacts mode:
- Tool and stable error reason:

**Compatibility report**
Run `imessage-mcp doctor --contacts none --privacy aggregate --json` and list only check names with pass/warn/fail states. Include sanitized timing and the smallest synthetic reproduction. Do not paste paths or raw tool results.

**Logs / screenshots**
Use synthetic evidence only. Do not post message contents, handles, contact names, group titles, URLs, database or WAL files, attributed-body blobs, attachment names or paths, opaque references, tokens, client configuration, home-directory paths, raw tool results, or screenshots of private conversations. Report security issues through the private advisory link in SECURITY.md.
