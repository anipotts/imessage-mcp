# Listing updates prepared for review

Checked 2026-09-08. These drafts have not been sent. Publish the tested 2.x package and demo before requesting a listing refresh.

## Claude Desktop extensions directory

Prepared 2026-09-14 for Anthropic's [desktop extension submission form](https://clau.de/desktop-extention-submission). Not submitted. Submit only a release whose bundle includes `privacy_policies`, and re-read the [submission requirements](https://claude.com/docs/connectors/building/submission) first.

Requirement check:

| requirement | where it is met |
| --- | --- |
| tool annotations | every tool has a `title`, `readOnlyHint: true`, and `destructiveHint: false`; `server_status` sets `openWorldHint: true` for its update lookup |
| privacy policy in README | `## privacy policy` in README.md |
| `privacy_policies` in manifest | manifest.json (manifest_version 0.3) |
| HTTPS policy covering collection, use, storage, sharing, retention, contact | [PRIVACY.md](https://github.com/anipotts/imessage-mcp/blob/main/PRIVACY.md) |
| setup and usage documentation | README setup and [GUIDE.md](https://github.com/anipotts/imessage-mcp/blob/main/docs/GUIDE.md) |
| helpful errors | fixed, value-free error messages, including the Full Disk Access fix |

Suggested answers:

- **Name:** iMessage History (the manifest `display_name` is "iMessage"; reviewers may ask for a name that cannot read as Apple's own)
- **Tagline:** Search and read your Messages history on your Mac
- **Description:**

> Ask Claude to find a message, catch up on a conversation, or count your texts. imessage-mcp gives Claude seven read-only tools over the iMessage, SMS, MMS, and RCS history already stored in Messages on your Mac: search, conversation timelines with edits and reactions, conversation lists, contact matching, activity and response-time analytics, incremental sync, and status. It cannot send, edit, or delete messages. Everything runs locally with its search index in memory; there are no accounts or telemetry. Results you ask for go to Claude like any tool result, and a privacy ceiling (full, redacted, or aggregate) and a contact-names switch limit what they contain. Requires macOS 14 or newer and Full Disk Access for Claude.

- **Categories:** productivity, communication
- **Documentation:** https://github.com/anipotts/imessage-mcp#readme
- **Privacy policy:** https://github.com/anipotts/imessage-mcp/blob/main/PRIVACY.md
- **Support:** https://github.com/anipotts/imessage-mcp/issues
- **Bundle:** https://github.com/anipotts/imessage-mcp/releases/latest/download/imessage-mcp.mcpb
- **Use cases:** finding a specific message by words in it; reading a conversation to catch up or draft a reply the user sends themselves; seeing who is waiting on a reply; counting messages and response times over a date range.
- **Prerequisites:** a Mac with macOS 14 or newer, Messages history on that Mac, and Full Disk Access granted to Claude. No account or credentials.
- **Reads or writes:** reads only.
- **Reviewer testing:** no credentials exist. Install the bundle on a Mac signed in to Messages, grant Full Disk Access to Claude, then ask "show my five most recent conversations", "find the message about dinner", and "how many messages did I send last week", and run each prompt (`catch_up`, `draft_reply`, `recap`). Without Full Disk Access, every tool returns the exact System Settings path to fix it. The repository's synthetic fixtures (`npm run test:protocol`) exercise every tool without personal data.
- **Data handling:** reads the user's own local Messages and Contacts data through macOS permissions; no third-party API. One optional anonymous version lookup to the public npm registry for this package, off with the "Check for updates" setting.

## Glama

[Current listing](https://glama.ai/mcp/servers/anipotts/imessage-mcp) still describes 26 tools, SSE, Docker, and a guarantee that data never leaves the machine. That reflects an older API and overstates the server's control over its client. The correction should explicitly identify 2.x; 1.3.1 remains the stable npm channel until 2.0.0 is published.

Suggested description:

> Read-only MCP server for iMessage, SMS, MMS, and RCS history already present in Apple Messages on a Mac. Version 2.x provides seven tools for search, conversation reads, contact resolution, analytics, sync, and status. It runs locally, collects no telemetry, and keeps decoded search data in memory. Returned results can be processed or retained by the MCP client and its model provider. Requires macOS 14+ and Node.js 22, 24, or 26; supports stdio and authenticated loopback HTTP.

Suggested refresh request:

> I maintain imessage-mcp. Please refresh the listing for the 2.x API: seven read-only tools, macOS only, stdio or authenticated loopback HTTP. SSE, Docker, bulk export, and the old 26-tool list do not apply to 2.x. Please also remove the claim that no data leaves the machine: the server is local, but an MCP client can send returned results to its model provider. The README includes setup, an installed-package demo with synthetic data, and reproducible benchmarks.

Attach the published version and its working README/demo URL when sending. No ownership claim or account change has been made.

## Awesome Claude Code

The [original response](https://github.com/hesreallyhim/awesome-claude-code/issues/842#issuecomment-3956567464) invited resubmission after March 4, 2026. The [current contributing rules](https://github.com/hesreallyhim/awesome-claude-code/blob/main/CONTRIBUTING.md) now require a human to submit using the web form. They explicitly disallow submission through gh. The age criterion is now 14 days with continued development, or 100 stars. No open submission by anipotts was found in this check.

Ani must review and submit the [resource form](https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml). The project is interoperable with other MCP clients; the guidelines prefer Claude Code-specific resources, so acceptance is not assured. Leave the form's personal attestations for Ani.

Prepared fields:

| field | value |
| --- | --- |
| Display Name | imessage-mcp |
| Category | Providers, Runtime & Integration Infrastructure |
| Link | https://github.com/anipotts/imessage-mcp |
| Author Name | Ani Potts |
| Author Link | https://github.com/anipotts |

Description:

> Read-only MCP server that lets Claude Code search and analyze Apple Messages history on macOS. Seven tools cover search, conversation reads, contacts, analytics, sync, and status, with full, redacted, and aggregate privacy modes and an in-memory search index.

The repository README will contain the working demo once this branch lands. Submit after the referenced 2.x installation command is publicly available.
