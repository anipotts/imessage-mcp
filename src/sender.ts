import type { UnifiedContactResolver } from "./contacts.js";
import { ImessageMcpError } from "./errors.js";

export interface SenderSource {
  is_from_me: unknown;
  handle_id: unknown;
  handle: unknown;
}

export interface ValidatedSender {
  direction: "incoming" | "outgoing";
  complete: boolean;
  identity: { name: string | null; handle: string | null };
}

function positiveHandleId(value: unknown): boolean {
  if (typeof value === "bigint") return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

export function validateSender(
  source: SenderSource,
  contacts: UnifiedContactResolver,
): ValidatedSender {
  const fromMe = Number(source.is_from_me);
  if (!Number.isSafeInteger(fromMe) || (fromMe !== 0 && fromMe !== 1)) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "a message has an invalid sender direction flag");
  }
  if (fromMe === 1) {
    return { direction: "outgoing", complete: true, identity: { name: "Me", handle: null } };
  }
  const handle = typeof source.handle === "string" && source.handle.length > 0 ? source.handle : null;
  if (!positiveHandleId(source.handle_id) || !handle) {
    return { direction: "incoming", complete: false, identity: { name: null, handle: null } };
  }
  return {
    direction: "incoming",
    complete: true,
    identity: { name: contacts.nameForHandle(handle), handle },
  };
}
