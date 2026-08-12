import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { ImessageMcpError } from "./errors.js";

export type ReferenceKind = "conversation" | "message" | "page" | "sync";

export const MAX_REFERENCE_LENGTH = 16_384;
export const MAX_SYNC_CURSOR_LENGTH = 128_000;

export interface ReferencePayload {
  v: 1;
  kind: ReferenceKind;
  lineage: string;
  value: Record<string, unknown>;
}

function keyFor(referenceKey: Buffer, lineage: string): Buffer {
  return createHmac("sha256", referenceKey).update("imessage-mcp:v2:reference\0").update(lineage).digest();
}

export function encodeReference(referenceKey: Buffer, lineage: string, kind: ReferenceKind, value: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(referenceKey, lineage), iv);
  const plaintext = Buffer.from(JSON.stringify({ v: 1, kind, lineage, value } satisfies ReferencePayload));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `im2_${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

export function decodeReference(
  referenceKey: Buffer,
  lineage: string,
  expectedKind: ReferenceKind,
  encoded: string,
  maxEncodedLength = MAX_REFERENCE_LENGTH,
): ReferencePayload {
  if (
    !Number.isSafeInteger(maxEncodedLength) || maxEncodedLength < 32 || maxEncodedLength > MAX_SYNC_CURSOR_LENGTH ||
    typeof encoded !== "string" || !encoded.startsWith("im2_") || encoded.length > maxEncodedLength
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "opaque reference has invalid encoding or size");
  }
  const body = encoded.slice(4);
  if (body.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(body)) {
    throw new ImessageMcpError("INVALID_INPUT", "opaque reference has invalid encoding or size");
  }
  const packed = Buffer.from(body, "base64url");
  if (packed.toString("base64url") !== body || packed.length < 29) {
    throw new ImessageMcpError("INVALID_INPUT", "opaque reference has invalid encoding or size");
  }
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  let payload: ReferencePayload;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(referenceKey, lineage), iv);
    decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as ReferencePayload;
  } catch {
    throw new ImessageMcpError("DATABASE_CHANGED", "reference does not belong to this database lineage");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ImessageMcpError("INVALID_INPUT", "opaque reference has an invalid payload shape");
  }
  if (payload.lineage !== lineage) {
    throw new ImessageMcpError("DATABASE_CHANGED", "reference does not belong to this database lineage");
  }
  if (
    payload.v !== 1 || payload.kind !== expectedKind || !payload.value ||
    typeof payload.value !== "object" || Array.isArray(payload.value)
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "opaque reference has the wrong kind or payload shape");
  }
  return payload;
}
