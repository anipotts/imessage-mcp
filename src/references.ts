import { ImessageMcpError } from "./errors.js";

// Cursors are plain, versioned JSON. They carry positions in the caller's own
// archive and the database watermark they were issued at; a changed or forged
// cursor can only return a different page of that same archive.
export type CursorKind = "page" | "sync";

export const MAX_CURSOR_LENGTH = 16_384;
export const MAX_SYNC_CURSOR_LENGTH = 128_000;

export function encodeCursor(kind: CursorKind, value: Record<string, unknown>): string {
  return `im3_${kind}_${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function decodeCursor(kind: CursorKind, encoded: unknown, maxLength = MAX_CURSOR_LENGTH): Record<string, unknown> {
  const prefix = `im3_${kind}_`;
  if (typeof encoded !== "string" || !encoded.startsWith(prefix) || encoded.length > maxLength) {
    throw new ImessageMcpError("INVALID_INPUT", `cursor is not a ${kind} cursor from this server`);
  }
  const body = encoded.slice(prefix.length);
  if (body.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(body)) {
    throw new ImessageMcpError("INVALID_INPUT", "cursor has invalid encoding");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", "cursor has invalid encoding");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImessageMcpError("INVALID_INPUT", "cursor has an invalid payload");
  }
  return value as Record<string, unknown>;
}

export function positiveId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ImessageMcpError("INVALID_INPUT", `${label} must be a positive integer`);
  }
  return value;
}
