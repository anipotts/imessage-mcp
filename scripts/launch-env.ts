// One place for the environment every test launch starts from: the operator's
// key and state variables never leak into a spawned server, and NODE_PATH cannot
// make a bundle resolve modules from outside itself.

const BLOCKED = new Set([
  "IMESSAGE_REFERENCE_KEY",
  "IMESSAGE_REFERENCE_KEY_FILE",
  "IMESSAGE_DATABASE_ID",
  "IMESSAGE_DATABASE_ID_FILE",
  "IMESSAGE_STATE_DIR",
  "NODE_PATH",
]);

export function cleanEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !BLOCKED.has(entry[0]),
      ),
    ),
    ...extra,
  };
}
