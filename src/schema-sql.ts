import type { ServiceFamily } from "./contracts.js";
import type { DatabaseRequest } from "./database.js";

export function hasColumn(request: DatabaseRequest, table: string, column: string): boolean {
  return request.capabilities.tables[table]?.includes(column) ?? false;
}

export function columnSql(
  request: DatabaseRequest,
  table: string,
  alias: string,
  column: string,
  fallback = "NULL",
): string {
  return hasColumn(request, table, column) ? `${alias}.${column}` : fallback;
}

export function serviceSql(request: DatabaseRequest, messageAlias = "m", chatAlias = "c"): string {
  const sources: string[] = [];
  if (hasColumn(request, "message", "service")) sources.push(`${messageAlias}.service`);
  if (hasColumn(request, "chat", "service_name")) sources.push(`${chatAlias}.service_name`);
  return sources.length ? `COALESCE(${[...sources, "'unknown'"].join(", ")})` : "'unknown'";
}

export function serviceFamilyCase(expression: string): string {
  const bounded = `LENGTH(CAST(COALESCE(${expression}, '') AS BLOB)) <= 4096`;
  const normalized = `LOWER(TRIM(${expression}))`;
  return `CASE
    WHEN ${bounded} AND ${normalized} = 'imessage' THEN 'imessage'
    WHEN ${bounded} AND ${normalized} = 'rcs' THEN 'rcs'
    WHEN ${bounded} AND ${normalized} IN ('sms', 'mms') THEN 'sms'
    ELSE 'unknown' END`;
}

export function serviceFamilyPredicate(expression: string, family: ServiceFamily): string {
  const bounded = `LENGTH(CAST(COALESCE(${expression}, '') AS BLOB)) <= 4096`;
  const normalized = `LOWER(TRIM(${expression}))`;
  if (family === "imessage") return `(${bounded} AND ${normalized} = 'imessage')`;
  if (family === "rcs") return `(${bounded} AND ${normalized} = 'rcs')`;
  if (family === "sms") return `(${bounded} AND ${normalized} IN ('sms', 'mms'))`;
  return `(NOT (${bounded}) OR COALESCE(${normalized}, '') NOT IN ('imessage', 'rcs', 'sms', 'mms'))`;
}
