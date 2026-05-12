// MCP prompts for common workflows.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "daily-triage",
    {
      description: "Build a daily iMessage triage queue with reply priorities.",
      argsSchema: {
        lookback_hours: z.number().optional().describe("Hours to consider for freshness (default 24)"),
      },
    },
    async (args) => {
      const hours = args.lookback_hours ?? 24;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Run needs_reply with inactive_hours=${hours} and follow_up_queue for dormant relationships. ` +
                "Summarize by urgency, then propose a 5-item action list.",
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "relationship-review",
    {
      description: "Generate a relationship communication review for a contact.",
      argsSchema: {
        contact: z.string().describe("Contact name, phone, or email"),
      },
    },
    async ({ contact }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Analyze communication dynamics with ${contact}. ` +
              "Use who_initiates, streaks, conversation_gaps, double_texts, and conversation_brief. " +
              "Return strengths, risks, and 3 concrete next actions.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "yearly-review",
    {
      description: "Compare two years of iMessage behavior.",
      argsSchema: {
        year_a: z.number().describe("First year"),
        year_b: z.number().describe("Second year"),
      },
    },
    async ({ year_a, year_b }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Compare iMessage activity between ${year_a} and ${year_b} using compare_wrapped. ` +
              "Highlight shifts in volume, contact concentration, and response patterns.",
          },
        },
      ],
    }),
  );
}

