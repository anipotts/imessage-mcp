// Shared helpers -- pagination, response formatting

// Format a result set as a text response for MCP
export function formatResults(
  rows: any[],
  total?: number,
  offset?: number,
  limit?: number,
): string {
  if (rows.length === 0) return "No results found.";

  let header = `${rows.length} result(s)`;
  if (total !== undefined && total > rows.length) {
    header = `Showing ${offset || 0}\u2013${(offset || 0) + rows.length} of ${total}`;
  }
  if (limit !== undefined) {
    header += ` (limit: ${limit})`;
  }

  return `${header}\n\n${JSON.stringify(rows, null, 2)}`;
}

// Clamp a number to a range
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// Default pagination limits
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
