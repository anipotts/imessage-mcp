---
name: imessage:search
description: "Find any message, any time"
---

## What This Does

Searches your entire iMessage history using flexible filters -- query text, contact name, date range, direction, group chats, and attachments. Automatically resolves natural language contact names to handles and expands individual hits into full conversation threads for context.

## How To Use

Just describe what you are looking for in plain English. You can mention a person by name, a topic, a time period, or any combination. The search will resolve contacts, find matching messages, and pull surrounding thread context when needed.

## Tools Orchestrated

1. `resolve_contact` -- Resolves a natural language name to a phone number or email handle
2. `search_messages` -- Searches messages with query, contact, date range, direction, group, and attachment filters
3. `get_conversation` -- Retrieves surrounding thread history for context around individual hits

## Examples

- "Find all messages where I talked about the trip to Japan"
- "What did Sarah text me last week?"
- "Search for messages with photos from December 2024"
- "Find any texts about dinner plans between me and Mom in the last month"

## Tips

- Use natural language contact names -- the search will resolve them automatically via `resolve_contact`
- Combine date ranges with keyword queries to narrow results fast
- If a search returns too many results, add a direction filter (sent vs received) or limit the date range
- Attachment filters work well for finding shared photos, links, or files
