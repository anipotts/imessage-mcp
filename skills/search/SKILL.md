---
name: search
description: Search iMessage history and expand relevant threads.
---

Use the `search_messages` tool to find messages by query, contact, date range, direction, group status, and attachment filters.

If the user does not provide enough search detail, ask what they want to find before running a broad query.

When message-level hits need context, call `get_conversation` to retrieve surrounding thread history and then summarize findings.

Keep summaries concise by default and only include long raw excerpts when the user explicitly asks.
