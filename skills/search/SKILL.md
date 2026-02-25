---
name: search
version: "1.3.0"
description: Search iMessage history and expand relevant threads.
allowed-tools:
  - search_messages
  - get_conversation
  - resolve_contact
---

Use the `search_messages` tool to find messages by query, contact, date range, direction, group status, and attachment filters.

If the user does not provide enough search detail, ask what they want to find before running a broad query.

When the user provides a contact name (not a phone number or email), call `resolve_contact` first to resolve the name to a handle before passing it to `search_messages`.

When message-level hits need context, call `get_conversation` to retrieve surrounding thread history and then summarize findings.

Keep summaries concise by default and only include long raw excerpts when the user explicitly asks.
