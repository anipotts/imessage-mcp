# imessage-mcp

Ask your assistant to find a message, read a conversation, or count your texts.
imessage-mcp connects it to the Apple Messages history on your Mac through seven read-only tools.

Search and analyze iMessage, SMS, MMS, and RCS history. The server runs locally, keeps its search index in memory, and collects no telemetry. Your MCP client or model provider can still receive and retain the results you ask for.

Try questions like:

- “Find the message about the restaurant reservation.”
- “Show my five most recent conversations.”
- “How many messages did I send last month?”

![Installed imessage-mcp searching synthetic Messages data](assets/demo.gif)

## setup

You need macOS 14+, Node.js 22 or newer, and Messages history on this Mac.

Two steps.

1. Add it to Claude Code:

```sh
claude mcp add imessage -- npx -y imessage-mcp@2
```

Codex:

```sh
codex mcp add imessage -- npx -y imessage-mcp@2
```

Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp@2"]
    }
  }
}
```

2. Restart the client and grant Full Disk Access to it when macOS asks.

One command does the same thing for any of the four clients, then prints the diagnostic summary:

```sh
npx -y imessage-mcp@2 setup --client claude
```

`--client` takes `claude`, `codex`, `desktop`, or `cursor`. Claude Desktop and Cursor rewrite their configuration files while they run, so quit the application first; setup backs the file up before it edits anything.

There is nothing else to create. The server generates its two private values on
first run under `~/Library/Application Support/imessage-mcp`, and reuses them
after a restart so saved conversation references keep working.

A bare `npx imessage-mcp` without `@2` resolves to the 1.x line until `latest` moves; the setup command above pins the major version.

To check the setup without a client, run the read-only diagnostic:

```sh
npx -y imessage-mcp@2 doctor --contacts none --privacy redacted
```

Ask the client to list your five most recent conversations. See the [setup guide](docs/GUIDE.md#client-setup) for more on each client.

stdio starts at `--privacy full` and `--contacts live`, matching what Messages and Contacts already authorize on this Mac. To start redacted (names, masked handles, and calendar days, with no message bodies) or without Contacts, add `--contacts none --privacy redacted` to the setup command above. Search works in redacted mode too; its results omit the text.

If `doctor` reports a database permission problem, grant Full Disk Access to the application launching the server, restart it, and run the diagnostic again. macOS grants that access to the whole application or shell, not narrowly to `imessage-mcp`. The diagnostic explains failed checks without changing settings.

A faithful database copy keeps its references only on the identity it was created with; an unrelated archive gets its own. [Details](docs/GUIDE.md#live-and-copied-databases).

If the generated key files ever lose their owner-only modes, repair them without touching any other setting:

```sh
npx -y imessage-mcp@2 doctor --fix
```

## remove

```sh
npx -y imessage-mcp@2 uninstall --client claude
```

Other servers in a Claude Desktop or Cursor configuration are left alone. Add `--purge --yes` to also delete the generated key files, which permanently invalidates saved conversation references.

## seven tools

| tool | what it does |
| --- | --- |
| `search_messages` | Find messages by literal substring, exact text, token, or phrase. |
| `get_conversation` | Read a timeline with current edits, reactions, receipts, replies, and group events. |
| `list_conversations` | Find direct and group chats by contact, service, reply state, or date. |
| `analyze_communication` | Count messages and calculate activity, response-time, and initiation metrics. |
| `sync_messages` | Pull new messages and lifecycle changes from a saved cursor. |
| `resolve_contact` | Match a name or handle and report ambiguity rather than guess. |
| `server_status` | Check versions, privacy settings, services, decoder health, and index state. |

Every 2.x tool reads data only. The server cannot send or modify messages, and it does not recover unsent text or old edited versions. Each tool advertises a display title and an output schema for its success envelope, so a client can label it and check the structured result.

## prompts

The server also advertises three prompts, which a compatible client (Claude Code included) surfaces as slash commands.

| prompt | arguments | what it asks the assistant to do |
| --- | --- | --- |
| `catch_up` | `contact`, `days` (default 7) | resolve the contact, read the recent conversation, and summarize what needs a reply |
| `draft_reply` | `contact`, `intent` (optional) | read the latest messages and draft a reply in the user's own style, for the user to send |
| `who_said` | `query` | search messages and list who said it, when, and in which conversation |

Prompts are text templates the client sends back to the assistant; none of them can send a message, since the server has no send tool.

## privacy

The startup setting is the most a caller can see. A request can choose the same mode or a stricter one:

| mode | what leaves the server |
| --- | --- |
| `full` | Current message text, names, handles, timestamps, and attachment metadata. |
| `redacted` | Names, masked handles, calendar days, and references; no bodies or filenames. |
| `aggregate` | Counts and metrics; no names, handles, text, or record references. |

Decoded search data stays in memory. Local execution does not control how your MCP client or model provider processes or retains returned results. Aggregate mode is redaction, not a formal anonymity guarantee.

Every message body, contact value, group title, URL, attachment filename, and database-derived string is untrusted archival data. Archived messages can contain instructions planted by someone else. Keep tool results separate from trusted instructions, and confirm external actions influenced by them. This boundary reduces risk but does not eliminate prompt injection.

See the [security policy](SECURITY.md) and [full privacy contract](docs/GUIDE.md#privacy-and-untrusted-history).

## compatibility and evidence

iMessage, SMS, MMS, and RCS are supported when they already appear in Messages on this Mac. The server reads a live Mac database or a faithful copy. Linux, Docker, iPhone backup manifests, and public HTTP hosting are unsupported. Optional authenticated HTTP is loopback-only; see the [guide](docs/GUIDE.md#http-and-tailscale-serve).

[Verification](VERIFICATION.md) separates automated tests from previous live checks; [the changelog](CHANGELOG.md) and [GitHub releases](https://github.com/anipotts/imessage-mcp/releases) record what shipped. [Benchmarks](docs/BENCHMARK.md) include a reproducible synthetic fixture and cold, warm, and refresh timings. The [installed demo](docs/DEMO.md) uses synthetic Messages data.

## development

```sh
npm ci
npm run verify
npm run test:performance
```

Use synthetic data only. See [contributing](CONTRIBUTING.md), the [complete guide](docs/GUIDE.md), and the [3.0 roadmap](docs/ROADMAP-3.0.md). Sending would be a separate product boundary, not a 2.x feature.

[MIT](LICENSE)
