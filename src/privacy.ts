import { createHmac } from "node:crypto";
import type { PrivacyMode } from "./contracts.js";
import { ImessageMcpError } from "./errors.js";

const LEVEL: Record<PrivacyMode, number> = { full: 0, redacted: 1, aggregate: 2 };
const BODY_KEYS = new Set([
  "text",
  "body",
  "snippet",
  "filename",
  "filenames",
  "attachment_filename",
  "attachment_filenames",
  "attachment_text",
  "path",
  "paths",
  "attachment_path",
  "attachment_paths",
  "transfer_name",
]);
const IDENTITY_KEYS = new Set([
  "name",
  "display_name",
  "contact",
  "contact_name",
  "handle",
  "handles",
  "participants",
  "conversation_ref",
  "message_ref",
  "chat_identifier",
  "guid",
]);

export function effectivePrivacy(ceiling: PrivacyMode, requested?: PrivacyMode): PrivacyMode {
  const mode = requested ?? ceiling;
  if (!(mode in LEVEL)) {
    throw new ImessageMcpError("INVALID_INPUT", "privacy mode must be full, redacted, or aggregate");
  }
  if (LEVEL[mode] < LEVEL[ceiling]) {
    throw new ImessageMcpError("PRIVACY_RESTRICTED", `startup privacy ceiling is ${ceiling}`);
  }
  return mode;
}

export function maskHandle(value: string, key: Buffer): string {
  const digest = createHmac("sha256", key).update(value.normalize("NFKC")).digest("hex").slice(0, 20);
  return `[masked:${digest}]`;
}

function calendarDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function attachmentName(path: string[], key: string | undefined): boolean {
  return key?.toLowerCase() === "name" && path.some((part) => part.toLowerCase() === "attachments");
}

function isExactTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function sanitize(value: unknown, mode: PrivacyMode, maskingKey: Buffer, key?: string, path: string[] = []): unknown {
  if (mode === "full") return value;
  const normalizedKey = key?.toLowerCase();

  const contentField = Boolean(normalizedKey && (BODY_KEYS.has(normalizedKey) || attachmentName(path, key)));
  if (mode === "redacted" && contentField) return undefined;
  if (mode === "aggregate" && normalizedKey && (contentField || IDENTITY_KEYS.has(normalizedKey))) {
    return undefined;
  }

  if (typeof value === "string") {
    if (normalizedKey?.includes("handle")) return maskHandle(value, maskingKey);
    if (
      mode === "redacted" &&
      (normalizedKey?.endsWith("_at") || normalizedKey === "at" || normalizedKey?.includes("timestamp") || isExactTimestamp(value))
    ) {
      return calendarDay(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitize(item, mode, maskingKey, key, path)).filter((item) => item !== undefined);
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      const sanitized = sanitize(child, mode, maskingKey, childKey, [...path, childKey]);
      if (sanitized !== undefined) out[childKey] = sanitized;
    }
    return out;
  }
  return value;
}

export function applyPrivacy<T>(value: T, mode: PrivacyMode, maskingKey: Buffer): T {
  return sanitize(value, mode, maskingKey) as T;
}

export function assertNoForbiddenFields(value: unknown, mode: PrivacyMode): void {
  if (mode === "full") return;
  const visit = (node: unknown, path: string[] = []): void => {
    if (Array.isArray(node)) return node.forEach((value) => visit(value, path));
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (BODY_KEYS.has(lower) || attachmentName(path, key) || (mode === "aggregate" && IDENTITY_KEYS.has(lower))) {
        throw new ImessageMcpError("PRIVACY_RESTRICTED", `forbidden ${mode} field: ${key}`);
      }
      if (mode === "redacted" && typeof child === "string" && isExactTimestamp(child)) {
        throw new ImessageMcpError("PRIVACY_RESTRICTED", "redacted output retained an exact timestamp");
      }
      visit(child, [...path, key]);
    }
  };
  visit(value);
}
