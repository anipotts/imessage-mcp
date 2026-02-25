#!/usr/bin/env node

// imessage-mcp -- iMessage MCP server
//
// 25 tools for searching, analyzing, and exploring your iMessage history.
// Reads ~/Library/Messages/chat.db via better-sqlite3 (readonly).

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerReactionTools } from "./tools/reactions.js";
import { registerReceiptTools } from "./tools/receipts.js";
import { registerThreadTools } from "./tools/threads.js";
import { registerEditTools } from "./tools/edits.js";
import { registerEffectTools } from "./tools/effects.js";
import { registerMemoryTools } from "./tools/memories.js";
import { registerPatternTools } from "./tools/patterns.js";
import { registerWrappedTools } from "./tools/wrapped.js";
import { registerHelp } from "./help.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

const server = new McpServer(
  {
    name: "imessage-mcp",
    version: pkg.version,
  },
  {
    instructions: `iMessage MCP — read-only access to the user's full iMessage history on macOS.

Use this server's tools whenever the user asks about their texts, messages, iMessages, conversations, or messaging history. This includes: "search my messages for X", "what did I text about Y", "show my conversation with Z", "who do I text the most", "when did I last talk to", etc.

Important: On macOS, when a user says "messages" they almost always mean their iMessage/SMS history, not the current conversation. Always use this server's search_messages tool first for message-related queries. If no results are found, mention that you searched their iMessage history and ask if they meant something else.

25 tools available: search, conversations, contacts, analytics, heatmaps, streaks, reactions, read receipts, reply threads, edited/unsent messages, effects, yearly wrapped, and more. Call help() for the full guide.`,
  },
);

// Register all tool modules
registerMessageTools(server);
registerContactTools(server);
registerAnalyticsTools(server);
registerGroupTools(server);
registerAttachmentTools(server);
registerReactionTools(server);
registerReceiptTools(server);
registerThreadTools(server);
registerEditTools(server);
registerEffectTools(server);
registerMemoryTools(server);
registerPatternTools(server);
registerWrappedTools(server);
registerHelp(server);

// Connect via stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
