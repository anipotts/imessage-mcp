// Gate G2: the pure decoders against Foundation on every body and edit history
// in the live Messages database. Read-only; prints counts only.
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MessageTextDecoder } from "../src/decoder.js";
import { decodeBody, decodeEditHistory } from "../src/archive.js";

const db = new Database(path.join(os.homedir(), "Library/Messages/chat.db"), { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");
const foundation = new MessageTextDecoder();
const BATCH = 400;
const tally = { bodies: 0, body_match: 0, body_mismatch: {} as Record<string, number>, summaries: 0, summary_match: 0, summary_mismatch: {} as Record<string, number>, pure_ms: 0, foundation_ms: 0 };

async function run(column: "attributedBody" | "message_summary_info") {
  let after = 0;
  await foundation.withSession(async () => {
    for (;;) {
      const rows = db.prepare(`SELECT ROWID AS id, ${column} AS blob FROM message WHERE ROWID > ? AND ${column} IS NOT NULL ORDER BY ROWID LIMIT ${BATCH}`).all(after) as Array<{ id: number; blob: Buffer }>;
      if (rows.length === 0) break;
      after = rows.at(-1)!.id;
      const blobs = rows.map((row) => row.blob);
      let started = performance.now();
      const reference = column === "attributedBody" ? await foundation.decode(blobs) : await foundation.decodeEditMetadata(blobs);
      tally.foundation_ms += performance.now() - started;
      started = performance.now();
      const pure = blobs.map((blob) => (column === "attributedBody" ? decodeBody(blob) : decodeEditHistory(blob)));
      tally.pure_ms += performance.now() - started;
      pure.forEach((result, index) => {
        const expected = reference[index];
        const same = JSON.stringify(result) === JSON.stringify(expected);
        if (column === "attributedBody") {
          tally.bodies += 1;
          if (same) tally.body_match += 1;
          else { const key = `${expected.status}->${result.status}`; tally.body_mismatch[key] = (tally.body_mismatch[key] ?? 0) + 1; }
        } else {
          tally.summaries += 1;
          if (same) tally.summary_match += 1;
          else { const key = `${expected.status}->${result.status}`; tally.summary_mismatch[key] = (tally.summary_mismatch[key] ?? 0) + 1; }
        }
      });
    }
  });
}

await run("attributedBody");
await run("message_summary_info");
db.close();
console.log(JSON.stringify({ ...tally, pure_ms: Math.round(tally.pure_ms), foundation_ms: Math.round(tally.foundation_ms) }));
