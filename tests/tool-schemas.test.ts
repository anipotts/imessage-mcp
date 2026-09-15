import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { API_VERSION } from "../src/contracts.js";
import { registerTools, type ToolRuntime } from "../src/server.js";

const TOOL_TITLES: Record<string, string> = {
  analyze_communication: "Analyze communication",
  get_attachment: "Get attachment",
  get_conversation: "Get conversation",
  list_conversations: "List conversations",
  resolve_contact: "Resolve contact",
  search_messages: "Search messages",
  server_status: "Server status",
  sync_messages: "Sync messages",
};

const SUCCESS: CallToolResult = {
  content: [{ type: "text", text: "server_status: complete" }],
  structuredContent: {
    api_version: API_VERSION,
    effective_scope: { privacy_mode: "full" },
    completeness: "complete",
    data: {
      api_version: API_VERSION,
      package_version: "2.0.0-test",
      privacy_ceiling: "full",
      source_mode: "copy",
      detected_services: ["imessage", "sms"],
      schema_capabilities: {
        schema_fingerprint: "synthetic",
        required_core: "available",
        chat_lookup: "available",
        attributed_body: "available",
        edits: "available",
        retractions: "available",
        reactions: "available",
        receipts: "available",
        receipt_changes: "available",
        replies: "available",
        attachments: "available",
        group_events: "available",
        rcs: "unknown",
        tables: { message: ["ROWID", "guid"] },
      },
      index_state: { state: "cold", indexed_messages: 0, memory_used_bytes: 0, memory_limit_bytes: 1024 },
      as_of: "im2_synthetic",
    },
  },
};

const ERROR: CallToolResult = {
  isError: true,
  content: [{ type: "text", text: "server_status: error DATABASE_UNAVAILABLE" }],
  structuredContent: {
    api_version: API_VERSION,
    error: { reason: "DATABASE_UNAVAILABLE", message: "synthetic failure" },
  },
};

const clients: Client[] = [];

async function connect(result: CallToolResult): Promise<Client> {
  const runtime = {
    call: () => Promise.resolve(result),
    invalidInput: () => result,
  } as unknown as ToolRuntime;
  const server = new McpServer({ name: "imessage-mcp-schema-test", version: "0.0.0" });
  registerTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "imessage-mcp-schema-test-client", version: "0.0.0" });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("tool titles and output schemas", () => {
  it("advertises a human title and an object output schema for every tool", async () => {
    const client = await connect(SUCCESS);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_TITLES).sort());
    for (const tool of listed.tools) {
      expect(tool.title).toBe(TOOL_TITLES[tool.name]);
      const outputSchema = tool.outputSchema as Record<string, unknown> | undefined;
      expect(outputSchema?.type).toBe("object");
      expect([...(outputSchema?.required as string[])].sort()).toEqual([
        "api_version",
        "completeness",
        "data",
        "effective_scope",
      ]);
      expect(Object.keys(outputSchema?.properties as Record<string, unknown>)).toContain("data");
    }
  });

  it("accepts a success envelope that matches the advertised schema", async () => {
    const client = await connect(SUCCESS);
    const result = await client.callTool({ name: "server_status", arguments: {} });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).api_version).toBe(API_VERSION);
  });

  it("passes error results through without output-schema validation", async () => {
    const client = await connect(ERROR);
    const result = await client.callTool({ name: "server_status", arguments: {} });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.data).toBeUndefined();
    expect((structured.error as { reason: string }).reason).toBe("DATABASE_UNAVAILABLE");
    expect(JSON.stringify(result.content)).not.toMatch(/validation error/iu);
  });
});
