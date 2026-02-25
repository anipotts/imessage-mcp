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

/** Subquery: only handles the user has sent at least one message to */
export function repliedToCondition(): string {
  return `h.id IN (
    SELECT DISTINCT h2.id FROM handle h2
    JOIN message m2 ON m2.handle_id = h2.ROWID
    WHERE m2.is_from_me = 1
  )`;
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
 * The blob contains a bplist with the text encoded as UTF-8.
 */
export function extractTextFromAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;

  try {
    // Strategy 1: Look for NSString marker followed by the text
    // The pattern is: "NSString" marker -> type byte -> length -> UTF-8 text
    const nsStringMarker = Buffer.from("NSString");
    let idx = blob.indexOf(nsStringMarker);
    if (idx === -1) {
      // Strategy 2: Look for "NSMutableString" marker
      const nsMutableMarker = Buffer.from("NSMutableString");
      idx = blob.indexOf(nsMutableMarker);
    }

    if (idx !== -1) {
      // Advance past the marker + some header bytes to find text content
      // The text typically follows a few bytes after the class name
      const searchStart = idx + 8;

      // Look for the actual text by scanning for a length-prefixed UTF-8 string
      // Format varies but generally: skip class metadata, find text block
      for (let i = searchStart; i < Math.min(searchStart + 50, blob.length - 2); i++) {
        const byte = blob[i];
        // Check for short string length byte (0x01-0x7f range indicates length)
        if (byte > 1 && byte < 128) {
          const potentialLen = byte;
          if (i + 1 + potentialLen <= blob.length) {
            const candidate = blob.subarray(i + 1, i + 1 + potentialLen);
            // Validate it's printable UTF-8 and at least 2 chars (skip metadata bytes)
            const text = candidate.toString("utf-8");
            if (text.length >= 2 && /^[\x20-\x7E\u00A0-\uFFFF]+/.test(text)) {
              return text.trim();
            }
          }
        }
      }
    }

    // Strategy 3: Brute-force scan for longest UTF-8 text run
    // This handles edge cases where the marker approach fails
    let bestText = "";
    let i = 0;
    while (i < blob.length) {
      // Skip null bytes and control characters
      if (blob[i] < 0x20 && blob[i] !== 0x0A && blob[i] !== 0x0D) {
        i++;
        continue;
      }

      // Try to read a text run
      let end = i;
      while (end < blob.length && (blob[end] >= 0x20 || blob[end] === 0x0A || blob[end] === 0x0D)) {
        end++;
      }

      if (end - i > bestText.length && end - i >= 2) {
        const candidate = blob.subarray(i, end).toString("utf-8").trim();
        // Filter out binary-looking strings and class names
        if (
          candidate.length > bestText.length &&
          !candidate.startsWith("NS") &&
          !candidate.startsWith("bplist") &&
          !candidate.includes("streamtyped") &&
          !/^[A-Z][a-z]+[A-Z]/.test(candidate) // Skip CamelCase class names
        ) {
          bestText = candidate;
        }
      }
      i = end + 1;
    }

    return bestText.length >= 2 ? bestText : null;
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
