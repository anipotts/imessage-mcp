import type { CallToolResult } from "@modelcontextprotocol/server";
import { API_VERSION, type Completeness, type PageInfo, type PrivacyMode, type SuccessEnvelope, type Warning } from "./contracts.js";
import { asImessageMcpError, ImessageMcpError } from "./errors.js";
import { applyPrivacy, assertNoForbiddenFields } from "./privacy.js";

const MAX_MCP_RESULT_BYTES = 4 * 1024 * 1024 - 4096;

function countBy<T extends string>(values: T[]): Record<T, number> {
  const output = {} as Record<T, number>;
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}

function aggregateProjection(tool: string, data: unknown): unknown {
  const value = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (tool === "resolve_contact") {
    const candidates = Array.isArray(value.candidates) ? value.candidates.length : value.contact ? 1 : 0;
    return { status: value.status, match_count: candidates };
  }
  if (tool === "list_conversations") {
    const rows = Array.isArray(value.conversations) ? value.conversations as Array<Record<string, unknown>> : [];
    return {
      conversation_count: rows.length,
      by_kind: countBy(rows.map((row) => String(row.kind) as "direct" | "group")),
      by_service: countBy(rows.flatMap((row) => Array.isArray(row.service_families) ? row.service_families.map(String) : []) as string[]),
    };
  }
  if (tool === "get_conversation") {
    const rows = Array.isArray(value.events) ? value.events as Array<Record<string, unknown>> : [];
    return {
      event_count: rows.length,
      by_type: countBy(rows.map((row) => String(row.event_type))),
      by_service: countBy(rows.map((row) => String(row.service_family))),
    };
  }
  if (tool === "search_messages") {
    const rows = Array.isArray(value.results) ? value.results as Array<Record<string, unknown>> : [];
    return {
      total_matches: Number(value.total_matches ?? rows.length),
      returned_count: rows.length,
      by_service: countBy(rows.map((row) => String(row.service_family))),
    };
  }
  if (tool === "sync_messages") {
    const rows = Array.isArray(value.changes) ? value.changes as Array<Record<string, unknown>> : [];
    return {
      change_count: rows.length,
      by_type: countBy(rows.map((row) => String(row.change_type))),
      by_service: countBy(rows.map((row) => String(row.service_family))),
      cursor: value.cursor,
    };
  }
  return data;
}

function summary(tool: string, envelope: SuccessEnvelope): string {
  const data = envelope.data as Record<string, unknown>;
  const count = [
    Array.isArray(data?.conversations) ? data.conversations.length : undefined,
    Array.isArray(data?.events) ? data.events.length : undefined,
    Array.isArray(data?.results) ? data.results.length : undefined,
    Array.isArray(data?.changes) ? data.changes.length : undefined,
    data?.conversation_count,
    data?.event_count,
    data?.returned_count,
    data?.change_count,
  ].find((value) => typeof value === "number");
  const suffix = count !== undefined ? `; count=${String(count)}` : "";
  return `${tool}: ${envelope.completeness}${suffix}`;
}

export function successResult(input: {
  tool: string;
  privacy: PrivacyMode;
  maskingKey: Buffer;
  effectiveScope: Record<string, unknown>;
  data: unknown;
  completeness?: Completeness;
  page?: PageInfo;
  warnings?: Warning[];
}): CallToolResult {
  const projected = input.privacy === "aggregate" ? aggregateProjection(input.tool, input.data) : input.data;
  const envelope: SuccessEnvelope = {
    api_version: API_VERSION,
    effective_scope: input.effectiveScope,
    completeness: input.completeness ?? (input.warnings?.length ? "partial" : "complete"),
    data: projected,
    ...(input.page ? { page: input.page } : {}),
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
  };
  const sanitized = applyPrivacy(envelope, input.privacy, input.maskingKey);
  assertNoForbiddenFields(sanitized, input.privacy);
  const result: CallToolResult = {
    content: [{ type: "text", text: summary(input.tool, sanitized) }],
    structuredContent: sanitized as unknown as Record<string, unknown>,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MCP_RESULT_BYTES) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "tool result exceeds the bounded 4 MiB response budget", {
      limit_bytes: MAX_MCP_RESULT_BYTES,
      retry: "use a smaller limit or a narrower query",
    });
  }
  return result;
}

const SAFE_DETAIL_KEYS = new Set([
  "estimated_bytes",
  "observed_bytes",
  "indexed_rows",
  "source_body_bytes",
  "source_relation_bytes",
  "source_relation_rows",
  "max_text_bytes",
  "max_blob_bytes",
  "max_summary_bytes",
  "max_relation_value_bytes",
  "max_relations_per_message",
  "limit_bytes",
  "match_count",
  "skipped_count",
  "retry",
  "capability",
  "state",
]);

function safeErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  if (Array.isArray(details.candidates)) safe.match_count = details.candidates.length;
  for (const [key, value] of Object.entries(details)) {
    if (SAFE_DETAIL_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function errorResult(tool: string, error: unknown, privacy: PrivacyMode, maskingKey: Buffer): CallToolResult {
  const normalized = asImessageMcpError(error);
  const details = safeErrorDetails(normalized.details);
  const structuredContent = {
    api_version: API_VERSION,
    error: {
      reason: normalized.reason,
      message: normalized.message,
      ...(details ? { details } : {}),
    },
  };
  const sanitized = applyPrivacy(structuredContent, privacy, maskingKey);
  assertNoForbiddenFields(sanitized, privacy);
  return {
    isError: true,
    content: [{ type: "text", text: `${tool}: error ${normalized.reason}` }],
    structuredContent: sanitized,
  };
}
