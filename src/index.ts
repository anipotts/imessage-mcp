#!/usr/bin/env node

// imessage-mcp -- iMessage MCP server
//
// 25 tools for searching, analyzing, and exploring your iMessage history.
// Reads ~/Library/Messages/chat.db via better-sqlite3 (readonly).

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

const server = new McpServer({
  name: "imessage-mcp",
  version: "1.1.0",
});

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
