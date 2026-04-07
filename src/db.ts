// Database layer -- better-sqlite3 readonly access to ~/Library/Messages/chat.db
//
// Sub-millisecond reads. All queries are parameterized via better-sqlite3's
// built-in binding (no string interpolation of user input).

import Database from "better-sqlite3";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_DB = path.join(homedir(), "Library/Messages/chat.db");
const CHAT_DB = process.env.IMESSAGE_DB || DEFAULT_DB;

// Apple epoch: 2001-01-01 00:00:00 UTC in Unix time
export const APPLE_EPOCH_OFFSET = 978307200;

// Date expression: converts Apple nanosecond timestamp -> local datetime string
export const DATE_EXPR = `datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;

// Filter out tapbacks and object-replacement-character-only messages
export const MSG_FILTER = `AND m.associated_message_type = 0 AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) AND COALESCE(m.text, '') <> '\ufffc' AND COALESCE(m.text, '') NOT LIKE '\ufffc\ufffc%'`;

// Same filters as an array — for tools that build dynamic WHERE clauses
export function baseMessageConditions(): string[] {
  return [
    "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
    "m.associated_message_type = 0",
    "COALESCE(m.text, '') <> '\ufffc'",
    "COALESCE(m.text, '') NOT LIKE '\ufffc\ufffc%'",
  ];
}

/** Filter: only include your own sent messages + messages from contacts you've replied to */
export function repliedToCondition(): string {
  return `(m.is_from_me = 1 OR h.id IN (
    SELECT DISTINCT h2.id FROM handle h2
    JOIN message m2 ON m2.handle_id = h2.ROWID
    WHERE m2.is_from_me = 1
  ))`;
}

// Tapback reaction types (associated_message_type values)
export const REACTION_TYPES: Record<number, string> = {
  2000: "love",
  2001: "like",
  2002: "dislike",
  2003: "laugh",
  2004: "emphasize",
  2005: "question",
  3000: "remove_love",
  3001: "remove_like",
  3002: "remove_dislike",
  3003: "remove_laugh",
  3004: "remove_emphasize",
  3005: "remove_question",
};

// iMessage effect style IDs -> human-readable names
export const EFFECT_NAMES: Record<string, string> = {
  "com.apple.MobileSMS.expressivesend.gentle": "gentle",
  "com.apple.MobileSMS.expressivesend.loud": "loud",
  "com.apple.MobileSMS.expressivesend.slam": "slam",
  "com.apple.MobileSMS.expressivesend.invisibleink": "invisible ink",
  "com.apple.messages.effect.CKConfettiEffect": "confetti",
  "com.apple.messages.effect.CKFireworksEffect": "fireworks",
  "com.apple.messages.effect.CKHappyBirthdayEffect": "balloons",
  "com.apple.messages.effect.CKHeartEffect": "heart screen",
  "com.apple.messages.effect.CKLasersEffect": "lasers",
  "com.apple.messages.effect.CKShootingStarEffect": "shooting star",
  "com.apple.messages.effect.CKSparklesEffect": "sparkles",
  "com.apple.messages.effect.CKSpotlightEffect": "spotlight",
  "com.apple.messages.effect.CKEchoEffect": "echo",
};

/** Check if safe mode is enabled (aggregate-only, no message bodies) */
export function isSafeMode(): boolean {
  return process.env.IMESSAGE_SAFE_MODE === "1" || process.env.IMESSAGE_SAFE_MODE === "true";
}

/** Redact text when safe mode is on */
export function safeText(text: string | null): string | null {
  if (!text) return null;
  return isSafeMode() ? "[REDACTED - safe mode]" : text;
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
    _db.pragma("journal_mode = WAL");
    _db.pragma("query_only = ON");
  }
  return _db;
}

/**
 * Extract text from NSAttributedString binary blob (attributedBody column).
 * On macOS 14+, some messages have null `text` but valid `attributedBody`.
 *
 * The blob is an NSKeyedArchiver-encoded NSAttributedString. The plain text
 * lives after an "NSString" class marker + a 5-byte preamble, then a
 * length-prefixed UTF-8 string:
 *
 *   [marker] [5 preamble bytes] [length] [UTF-8 text]
 *
 * Length encoding:
 *   - If first byte after preamble is 0x81, length is next 2 bytes (LE uint16)
 *   - Otherwise, the byte itself is the length (for messages <= 127 chars)
 *
 * References: LangChain iMessage loader, imessage_tools project.
 */
export function extractTextFromAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;

  try {
    const nsStringMarker = Buffer.from("NSString");
    let idx = blob.indexOf(nsStringMarker);
    let markerLen = nsStringMarker.length;

    if (idx === -1) {
      const nsMutableMarker = Buffer.from("NSMutableString");
      idx = blob.indexOf(nsMutableMarker);
      markerLen = nsMutableMarker.length;
    }

    if (idx === -1) return null;

    // Skip past the marker + 5 preamble bytes
    const preambleLen = 5;
    const contentStart = idx + markerLen + preambleLen;
    if (contentStart >= blob.length) return null;

    const content = blob.subarray(contentStart);

    let textLength: number;
    let textStart: number;

    if (content[0] === 0x81) {
      // 3-byte length encoding: flag byte 0x81 + 2-byte little-endian uint16
      if (content.length < 3) return null;
      textLength = content[1] | (content[2] << 8);
      textStart = 3;
    } else {
      // 1-byte length encoding (messages <= 127 chars)
      textLength = content[0];
      textStart = 1;
    }

    if (textStart + textLength > content.length) return null;

    const text = content.subarray(textStart, textStart + textLength).toString("utf-8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get message text, falling back to attributedBody extraction when text is null
 * or when text is just the object replacement character (U+FFFC) placeholder.
 */
export function getMessageText(row: any): string | null {
  if (row.text && row.text !== "\ufffc" && !row.text.startsWith("\ufffc\ufffc")) {
    return row.text;
  }
  if (row.attributedBody) {
    return extractTextFromAttributedBody(row.attributedBody);
  }
  return null;
}
