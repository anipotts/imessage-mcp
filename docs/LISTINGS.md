# Listing updates prepared for review

Checked 2026-09-08. These drafts have not been sent. Publish the tested 2.x package and demo before requesting a listing refresh.

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
