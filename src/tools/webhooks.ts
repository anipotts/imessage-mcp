// Webhook workflow tools.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  replayWebhookSubscription,
} from "../webhooks.js";

export function registerWebhookTools(server: McpServer) {
  server.tool(
    "create_webhook_subscription",
    "Create a signed webhook subscription for realtime iMessage events.",
    {
      url: z.string().describe("Webhook endpoint URL"),
      events: z.array(z.enum(["messages.created"])).optional().describe("Event types (default: [messages.created])"),
      include_text: z.boolean().optional().describe("Include message text in payloads"),
      enabled: z.boolean().optional().describe("Whether subscription is active (default true)"),
      secret: z.string().optional().describe("Optional HMAC secret (generated if omitted)"),
      profile_id: z.string().optional().describe("Profile namespace (defaults to active profile)"),
      filter_contact_contains: z.string().optional().describe("Only deliver events involving matching contact/group text"),
      filter_keyword_any: z.array(z.string()).optional().describe("Only deliver events containing any keyword"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const created = await createWebhookSubscription({
        url: params.url,
        events: params.events,
        include_text: params.include_text,
        enabled: params.enabled,
        secret: params.secret,
        profile_id: params.profile_id,
        filter_contact_contains: params.filter_contact_contains,
        filter_keyword_any: params.filter_keyword_any,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(created, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "list_webhook_subscriptions",
    "List webhook subscriptions visible to the current principal/profile.",
    {
      profile_id: z.string().optional().describe("Filter by profile id"),
      include_all: z.boolean().optional().describe("Include disabled subscriptions"),
      include_secret: z.boolean().optional().describe("Include secrets in output (default false)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const rows = listWebhookSubscriptions({
        profile_id: params.profile_id,
        include_all: params.include_all,
      });

      const output = rows.map((sub) => {
        if (params.include_secret) return sub;
        const { secret: _secret, ...safe } = sub;
        return safe;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "delete_webhook_subscription",
    "Delete a webhook subscription by id.",
    {
      id: z.string().describe("Subscription id"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async ({ id }) => {
      const deleted = deleteWebhookSubscription(id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id, deleted }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "replay_webhook_subscription",
    "Replay logged events to a webhook subscription (backfill/recovery).",
    {
      id: z.string().describe("Subscription id"),
      since_seq: z.number().optional().describe("Replay events with seq greater than this"),
      since_rowid: z.number().optional().describe("Replay events with cursor_after_rowid greater than this"),
      since_event_id: z.string().optional().describe("Compatibility alias: replay events after this event id"),
      limit: z.number().optional().describe("Maximum events to replay (default 200)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const result = await replayWebhookSubscription({
        id: params.id,
        since_seq: params.since_seq,
        since_rowid: params.since_rowid,
        since_event_id: params.since_event_id,
        limit: params.limit,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
