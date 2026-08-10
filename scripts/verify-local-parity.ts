import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAddressBookStatus,
  lookupContact,
  resolveContact,
} from "../src/contacts.js";
import {
  extractTextFromAttributedBody,
  openReadonlyDatabase,
} from "../src/db.js";

const MAX_BLOBS = 500;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_HANDLES = 200;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decoderScript = join(projectRoot, "scripts", "foundation-decode.js");
const databasePath = process.env.IMESSAGE_DB
  || join(homedir(), "Library", "Messages", "chat.db");

interface BlobRow {
  rowid: number;
  attributedBody: Buffer;
}

interface NativeDecodeResult {
  status: string;
  text?: string;
}

function selectAttributedBodies(): BlobRow[] {
  const database = openReadonlyDatabase(databasePath);
  try {
    const total = Number((database.prepare(`
      SELECT COUNT(*) AS count
      FROM message
      WHERE text IS NULL
        AND attributedBody IS NOT NULL
        AND associated_message_type = 0
        AND length(attributedBody) <= 1048576
    `).get() as { count: number }).count);
    if (total === 0) return [];

    const width = Math.min(100, total);
    const offsets = [...new Set([
      0,
      Math.max(0, Math.floor(total * 0.25) - Math.floor(width / 2)),
      Math.max(0, Math.floor(total * 0.5) - Math.floor(width / 2)),
      Math.max(0, Math.floor(total * 0.75) - Math.floor(width / 2)),
      Math.max(0, total - width),
    ])];
    const statement = database.prepare(`
      SELECT ROWID AS rowid, attributedBody
      FROM message
      WHERE text IS NULL
        AND attributedBody IS NOT NULL
        AND associated_message_type = 0
        AND length(attributedBody) <= 1048576
      ORDER BY ROWID ASC
      LIMIT @limit OFFSET @offset
    `);

    const selected = new Map<number, BlobRow>();
    let bytes = 0;
    for (const offset of offsets) {
      const rows = statement.all({ limit: width, offset }) as BlobRow[];
      for (const row of rows) {
        if (selected.has(row.rowid)) continue;
        if (selected.size >= MAX_BLOBS || bytes + row.attributedBody.length > MAX_TOTAL_BYTES) {
          return [...selected.values()];
        }
        selected.set(row.rowid, row);
        bytes += row.attributedBody.length;
      }
    }
    return [...selected.values()];
  } finally {
    database.close();
  }
}

function decodeWithFoundation(rows: BlobRow[]): NativeDecodeResult[] {
  const raw = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", decoderScript],
    {
      input: JSON.stringify({
        blobs: rows.map((row) => row.attributedBody.toString("base64")),
      }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const response = JSON.parse(raw) as {
    status: string;
    results?: NativeDecodeResult[];
  };
  if (response.status !== "ok" || !Array.isArray(response.results)) {
    throw new Error("native_decoder_failed");
  }
  return response.results;
}

function selectHandles(): string[] {
  const database = openReadonlyDatabase(databasePath);
  try {
    return (database.prepare(`
      SELECT h.id
      FROM handle h
      JOIN message m ON m.handle_id = h.ROWID
      WHERE h.id IS NOT NULL AND trim(h.id) <> ''
      GROUP BY h.id
      ORDER BY MIN(m.ROWID) ASC
      LIMIT @limit
    `).all({ limit: MAX_HANDLES }) as Array<{ id: string }>).map((row) => row.id);
  } finally {
    database.close();
  }
}

function fail(reason: string, evidence: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ status: "fail", reason, ...evidence }));
  process.exit(1);
}

try {
  const rows = selectAttributedBodies();
  if (rows.length === 0) fail("no_attributed_bodies");
  const decoded = decodeWithFoundation(rows);

  let nativeDecoded = 0;
  let nativeSkipped = 0;
  let parserMatches = 0;
  let parserMismatches = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const native = decoded[index];
    if (native?.status !== "decoded" || typeof native.text !== "string") {
      nativeSkipped += 1;
      continue;
    }
    nativeDecoded += 1;
    const expected = native.text.trim() || null;
    const actual = extractTextFromAttributedBody(rows[index].attributedBody);
    if (actual === expected) parserMatches += 1;
    else parserMismatches += 1;
  }

  const addressBook = getAddressBookStatus();
  if (!addressBook.available) fail("contacts_unavailable");
  const handles = selectHandles();
  if (handles.length === 0) fail("no_message_handles");

  let unique = 0;
  let ambiguous = 0;
  let notFound = 0;
  let contactMismatches = 0;
  for (const handle of handles) {
    const resolution = resolveContact(handle);
    const lookup = lookupContact(handle);
    if (resolution.status === "unique") {
      unique += 1;
      if (lookup.tier !== "known" || lookup.name !== resolution.candidate.name) {
        contactMismatches += 1;
      }
    } else if (resolution.status === "ambiguous") {
      ambiguous += 1;
      if (lookup.tier !== "unknown" || lookup.name !== handle.trim()) {
        contactMismatches += 1;
      }
    } else if (resolution.status === "not_found") {
      notFound += 1;
      if (lookup.tier !== "unknown") contactMismatches += 1;
    } else {
      contactMismatches += 1;
    }
  }

  if (nativeDecoded === 0 || parserMismatches > 0 || contactMismatches > 0) {
    fail("parity_mismatch", {
      parser: {
        selected: rows.length,
        native_decoded: nativeDecoded,
        native_skipped: nativeSkipped,
        matches: parserMatches,
        mismatches: parserMismatches,
      },
      contacts: {
        selected: handles.length,
        unique,
        ambiguous,
        not_found: notFound,
        mismatches: contactMismatches,
      },
    });
  }

  console.log(JSON.stringify({
    status: "pass",
    parser: {
      selected: rows.length,
      native_decoded: nativeDecoded,
      native_skipped: nativeSkipped,
      matches: parserMatches,
      mismatches: 0,
    },
    contacts: {
      selected: handles.length,
      unique,
      ambiguous,
      not_found: notFound,
      mismatches: 0,
    },
    emitted_private_values: 0,
  }));
} catch (_error) {
  fail("verification_failed");
}
