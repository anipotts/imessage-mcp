# Workflow Recipes (n8n / Zapier / Copilot)

This document provides starter integration patterns for the new webhook + replay tools.

## 1) n8n realtime triage (webhook trigger)

1. Create a webhook subscription from your MCP client:

```json
{
  "tool": "create_webhook_subscription",
  "arguments": {
    "url": "https://<your-n8n-domain>/webhook/imessage-events",
    "events": ["messages.created"],
    "include_text": false,
    "filter_contact_contains": "VIP"
  }
}
```

2. In n8n:
- Add `Webhook` node at `/webhook/imessage-events`
- Verify `X-iMessage-Signature-256` using your shared secret
- Branch on `data.count` and `data.senders`
- Call MCP `needs_reply` + `follow_up_queue`
- Send digest to Slack/Email/Notion

## 2) Zapier fallback replay job

Use `replay_webhook_subscription` on schedule to backfill missed events after outages:

```json
{
  "tool": "replay_webhook_subscription",
  "arguments": {
    "id": "sub_xxx",
    "since_rowid": 0,
    "limit": 200
  }
}
```

Recommended Zap:
- Trigger: Schedule (every 15 min)
- Action 1: MCP tool call `replay_webhook_subscription`
- Action 2: Filter where `attempted > delivered`
- Action 3: Alert ops channel

## 3) Copilot Studio memory copilot pipeline

- Connect MCP server in Copilot Studio
- Use `list_changes` as incremental source
- Persist `sync_cursor.after_rowid` in Copilot memory/state
- On each run:
  1. call `list_changes`
  2. if non-empty, run `conversation_brief` for high-priority contacts
  3. update cursor

## 4) Search acceleration for agent flows

For latency-sensitive agent runs:
- keep sidecar index warm using `rebuild_search_index` periodically
- run `search_messages` with `search_mode: "auto"`
- for fuzzy intent-style lookup, use `search_mode: "semantic"`

## 5) Multi-profile/shared host guidance

- Configure `IMESSAGE_PROFILES` with separate db paths
- Issue per-client OAuth tokens bound to specific profiles/scopes
- Use `X-iMessage-Profile` header when a client can access >1 profile
- Keep webhook subscriptions profile-scoped
