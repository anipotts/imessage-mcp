import type { DatabaseRequest } from "../database.js";
import { ImessageMcpError } from "../errors.js";

const MAX_GUID_LOOKUPS = 1_000;
const MAX_GUID_BYTES = 4_096;

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

export function resolveUniqueMessageGuids(
  request: DatabaseRequest,
  guids: string[],
  maxMessageId: number,
): Map<string, number> {
  const unique = [...new Set(guids)];
  if (unique.length === 0) return new Map();
  if (
    unique.length > MAX_GUID_LOOKUPS ||
    unique.some((guid) => guid.length === 0 || Buffer.byteLength(guid, "utf8") > MAX_GUID_BYTES)
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "message GUID validation exceeds its bounded lookup budget");
  }
  const rows = request.db.prepare(
    `SELECT guid, MIN(ROWID) AS rowid, COUNT(*) AS matches
     FROM message
     WHERE ROWID <= ? AND guid IN (${placeholders(unique)})
     GROUP BY guid`,
  ).all(maxMessageId, ...unique) as Array<{ guid: string; rowid: number; matches: number }>;
  const resolved = new Map<string, number>();
  for (const row of rows) {
    if (Number(row.matches) !== 1 || !Number.isSafeInteger(Number(row.rowid)) || Number(row.rowid) <= 0) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "a message GUID does not identify exactly one message");
    }
    resolved.set(row.guid, Number(row.rowid));
  }
  return resolved;
}
