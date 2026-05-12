// Privacy/redaction helpers shared across tools and response normalization.

import { createHash } from "node:crypto";

export type RedactionProfile = "off" | "safe" | "strict";

const SAFE_PLACEHOLDER = "[REDACTED - safe mode]";
const STRICT_PLACEHOLDER = "[REDACTED - strict mode]";

const PHONE_RE = /^\+?[\d().\-\s]{7,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STRICT_IDENTIFIER_KEYS = new Set([
  "handle",
  "contact",
  "contact_name",
  "name",
  "group_name",
  "chat_id",
  "chat_identifier",
  "email",
  "phone",
]);

const ALWAYS_TEXT_KEYS = new Set([
  "text",
  "message_text",
  "reacted_to_text",
  "ice_breaker_text",
]);

function parseCsv(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

function profileFromEnv(raw: string | undefined): RedactionProfile | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "safe" || normalized === "strict") {
    return normalized;
  }
  return null;
}

export function getRedactionProfile(): RedactionProfile {
  const explicit = profileFromEnv(process.env.IMESSAGE_REDACTION_PROFILE);
  if (explicit) return explicit;

  const safeMode = process.env.IMESSAGE_SAFE_MODE === "1" || process.env.IMESSAGE_SAFE_MODE === "true";
  return safeMode ? "safe" : "off";
}

export function isSafeMode(): boolean {
  return getRedactionProfile() !== "off";
}

export function redactMessageText(text: string | null): string | null {
  if (!text) return null;
  const profile = getRedactionProfile();
  if (profile === "off") return text;
  return profile === "strict" ? STRICT_PLACEHOLDER : SAFE_PLACEHOLDER;
}

function stableMask(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `[REDACTED:${digest}]`;
}

function shouldRedactByConfiguredFields(key: string | null): boolean {
  if (!key) return false;
  const configured = parseCsv(process.env.IMESSAGE_REDACTION_FIELDS);
  if (configured.size === 0) return false;
  return configured.has(key.toLowerCase());
}

function redactStringValue(value: string, key: string | null, profile: RedactionProfile): string {
  if (profile === "off") return value;

  if (shouldRedactByConfiguredFields(key)) {
    return profile === "strict" ? STRICT_PLACEHOLDER : SAFE_PLACEHOLDER;
  }

  const lowerKey = key?.toLowerCase() ?? null;
  if ((lowerKey && ALWAYS_TEXT_KEYS.has(lowerKey)) || (lowerKey && lowerKey.includes("text"))) {
    return profile === "strict" ? STRICT_PLACEHOLDER : SAFE_PLACEHOLDER;
  }

  if (profile === "strict") {
    if ((lowerKey && STRICT_IDENTIFIER_KEYS.has(lowerKey)) || PHONE_RE.test(value) || EMAIL_RE.test(value)) {
      return stableMask(value);
    }
  }

  return value;
}

export function redactStructuredValue(value: unknown, path: string[] = []): unknown {
  const profile = getRedactionProfile();
  if (profile === "off") return value;

  if (typeof value === "string") {
    const key = path.length > 0 ? path[path.length - 1] : null;
    return redactStringValue(value, key, profile);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item, path));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactStructuredValue(v, [...path, k]);
    }
    return out;
  }

  return value;
}

