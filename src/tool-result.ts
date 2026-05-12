// Tool result normalization helpers.
//
// Ensures every tool returns:
// - human-readable `content` text for backward compatibility
// - `structuredContent` with a stable schema envelope for workflow clients

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactStructuredValue } from "./privacy.js";
import { checkToolAccess } from "./access.js";

export const STRUCTURED_SCHEMA_VERSION = "2026-02-25.1";

type ParsedTextPayload = {
  data: unknown;
  header?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonMaybe(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDataFromText(text: string): ParsedTextPayload | null {
  const direct = parseJsonMaybe(text);
  if (direct !== null) return { data: direct };

  const splitIdx = text.indexOf("\n\n");
  if (splitIdx === -1) return null;

  const header = text.slice(0, splitIdx);
  const tail = text.slice(splitIdx + 2);
  const parsedTail = parseJsonMaybe(tail);
  if (parsedTail === null) return null;
  return { data: parsedTail, header };
}

function normalizeContentWithRedaction(result: CallToolResult, redactedData: unknown): CallToolResult {
  const content = Array.isArray(result.content) ? result.content : [];
  let updated = false;
  const nextContent = content.map((item) => {
    if (!isObject(item) || item.type !== "text" || typeof item.text !== "string") {
      return item;
    }

    const parsed = extractDataFromText(item.text);
    if (!parsed) return item;

    updated = true;
    const body = stringifySafe(redactedData);
    return {
      ...item,
      text: parsed.header ? `${parsed.header}\n\n${body}` : body,
    };
  });

  if (!updated && nextContent.length === 0) {
    nextContent.push({ type: "text", text: stringifySafe(redactedData) });
  }

  return { ...result, content: nextContent as CallToolResult["content"] };
}

function inferDataFromResult(result: CallToolResult): unknown {
  if (isObject(result.structuredContent)) {
    // If a tool already returns structuredContent, preserve its data shape.
    return result.structuredContent;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!isObject(item) || item.type !== "text" || typeof item.text !== "string") continue;

    const parsed = extractDataFromText(item.text);
    if (parsed) return parsed.data;
    return { text: item.text };
  }

  return {};
}

export function normalizeToolResult(toolName: string, raw: CallToolResult | undefined): CallToolResult {
  const base: CallToolResult = raw ?? {
    content: [{ type: "text", text: "No result returned." }],
  };

  const inferred = inferDataFromResult(base);
  const redacted = redactStructuredValue(inferred);

  const wrappedStructured = {
    schema_version: STRUCTURED_SCHEMA_VERSION,
    tool: toolName,
    data: redacted,
  };

  const withRedactedContent = normalizeContentWithRedaction(base, redacted);

  return {
    ...withRedactedContent,
    structuredContent: wrappedStructured,
  };
}

export function normalizeToolError(toolName: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const structured = {
    schema_version: STRUCTURED_SCHEMA_VERSION,
    tool: toolName,
    error: {
      code: "TOOL_EXECUTION_ERROR",
      message,
    },
  };

  return {
    isError: true,
    content: [{ type: "text", text: `Error in ${toolName}: ${message}` }],
    structuredContent: structured,
  };
}

export function normalizeToolAccessDenied(toolName: string, missingScopes: string[]): CallToolResult {
  const structured = {
    schema_version: STRUCTURED_SCHEMA_VERSION,
    tool: toolName,
    error: {
      code: "FORBIDDEN",
      message: `Missing required scope(s): ${missingScopes.join(", ")}`,
      missing_scopes: missingScopes,
    },
  };

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Access denied for ${toolName}. Missing scope(s): ${missingScopes.join(", ")}`,
      },
    ],
    structuredContent: structured,
  };
}

const WRAPPED_MARKER = Symbol.for("imessage-mcp.tool-wrapper");

export function installToolResultWrapper(server: McpServer): void {
  const anyServer = server as any;
  if (anyServer[WRAPPED_MARKER]) return;

  const originalTool = anyServer.tool.bind(server);

  anyServer.tool = (...args: any[]) => {
    const handler = args[args.length - 1];
    if (typeof handler !== "function") {
      return originalTool(...args);
    }

    const toolName = String(args[0] ?? "unknown_tool");
    args[args.length - 1] = async (...handlerArgs: any[]) => {
      try {
        const access = checkToolAccess(toolName);
        if (!access.ok) {
          return normalizeToolAccessDenied(toolName, access.missing_scopes ?? []);
        }

        const result = await handler(...handlerArgs);
        return normalizeToolResult(toolName, result as CallToolResult | undefined);
      } catch (error) {
        return normalizeToolError(toolName, error);
      }
    };

    return originalTool(...args);
  };

  anyServer[WRAPPED_MARKER] = true;
}
