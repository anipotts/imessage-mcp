import { ImessageMcpError } from "./errors.js";

export const APPLE_EPOCH_UNIX_SECONDS = 978_307_200;
const INTEGER_TOKEN = /^-?(?:0|[1-9]\d*)$/u;
const APPLE_NANOSECOND_THRESHOLD = 1_000_000_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const MILLISECONDS_PER_SECOND = 1_000n;

export interface DateBounds {
  timezone: string;
  from_unix_seconds?: number;
  to_unix_seconds?: number;
}

export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `invalid IANA timezone: ${timezone}`);
  }
}

function parseLocalDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ImessageMcpError("INVALID_INPUT", "dates must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new ImessageMcpError("INVALID_INPUT", `invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

function addCalendarDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function partsAt(epochMs: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localMidnightUnixSeconds(parts: { year: number; month: number; day: number }, timezone: string): number {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = partsAt(candidate, timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = target - observedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  const verified = partsAt(candidate, timezone);
  if (
    verified.year !== parts.year ||
    verified.month !== parts.month ||
    verified.day !== parts.day ||
    verified.hour !== 0 ||
    verified.minute !== 0
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "local midnight could not be represented in the selected timezone");
  }
  return Math.floor(candidate / 1000);
}

export function compileDateBounds(input: { date_from?: string; date_to?: string; timezone?: string }): DateBounds {
  const timezone = validateTimezone(input.timezone ?? defaultTimezone());
  const from = input.date_from ? parseLocalDate(input.date_from) : undefined;
  const through = input.date_to ? parseLocalDate(input.date_to) : undefined;
  const result: DateBounds = { timezone };
  if (from) result.from_unix_seconds = localMidnightUnixSeconds(from, timezone);
  if (through) result.to_unix_seconds = localMidnightUnixSeconds(addCalendarDays(through, 1), timezone);
  if (
    result.from_unix_seconds !== undefined &&
    result.to_unix_seconds !== undefined &&
    result.from_unix_seconds >= result.to_unix_seconds
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "date_from must not be after date_to");
  }
  return result;
}

export function appleUnixSecondsExpression(column: string): string {
  return `(CASE WHEN COALESCE(${column}, 0) >= ${APPLE_NANOSECOND_THRESHOLD.toString()}
      OR COALESCE(${column}, 0) <= -${APPLE_NANOSECOND_THRESHOLD.toString()}
    THEN (${column} / 1000000000.0) ELSE ${column} END + ${APPLE_EPOCH_UNIX_SECONDS})`;
}

export function appleTimestampBoundary(unixSeconds: number): { seconds: number; nanoseconds: bigint } {
  const seconds = unixSeconds - APPLE_EPOCH_UNIX_SECONDS;
  if (!Number.isSafeInteger(seconds)) {
    throw new ImessageMcpError("INVALID_INPUT", "date boundary exceeds the supported timestamp range");
  }
  return { seconds, nanoseconds: BigInt(seconds) * NANOSECONDS_PER_SECOND };
}

export function appleTimestampBoundarySql(
  column: string,
  operator: ">=" | "<",
  secondsPlaceholder: string,
  nanosecondsPlaceholder: string,
): string {
  return `(CASE WHEN COALESCE(${column}, 0) >= ${APPLE_NANOSECOND_THRESHOLD.toString()}
      OR COALESCE(${column}, 0) <= -${APPLE_NANOSECOND_THRESHOLD.toString()}
    THEN ${column} ${operator} ${nanosecondsPlaceholder}
    ELSE ${column} ${operator} ${secondsPlaceholder} END)`;
}

export function appleTimestampSortSql(column: string): string {
  return `(CASE WHEN COALESCE(${column}, 0) >= ${APPLE_NANOSECOND_THRESHOLD.toString()}
      OR COALESCE(${column}, 0) <= -${APPLE_NANOSECOND_THRESHOLD.toString()}
    THEN CAST(COALESCE(${column}, 0) AS INTEGER)
    ELSE CAST(COALESCE(${column}, 0) AS INTEGER) * ${NANOSECONDS_PER_SECOND.toString()} END)`;
}

export function appleTimestampSortToken(value: unknown, label = "Apple timestamp"): string {
  const raw = BigInt(sqliteIntegerToken(value, label));
  return (raw < 0n ? -raw : raw) >= APPLE_NANOSECOND_THRESHOLD
    ? raw.toString()
    : (raw * NANOSECONDS_PER_SECOND).toString();
}

export function sqliteIntegerToken(value: unknown, label = "Messages integer value"): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && INTEGER_TOKEN.test(value)) {
    try {
      return BigInt(value).toString();
    } catch {
      // Fall through to the stable schema error below.
    }
  }
  throw new ImessageMcpError("UNSUPPORTED_SCHEMA", `${label} is not an exact SQLite integer`);
}

export function sqliteIntegerBinding(value: string): bigint {
  try {
    return BigInt(sqliteIntegerToken(value));
  } catch (error) {
    if (error instanceof ImessageMcpError) throw error;
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages integer value cannot be bound exactly");
  }
}

export function compareSqliteIntegers(left: string, right: string): number {
  const leftValue = sqliteIntegerBinding(left);
  const rightValue = sqliteIntegerBinding(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function sqliteIntegerIsPositive(value: string): boolean {
  return sqliteIntegerBinding(value) > 0n;
}

export function appleTimestampToIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) {
    if (value <= 0) return null;
    const appleSeconds = Math.abs(value) >= Number(APPLE_NANOSECOND_THRESHOLD) ? value / 1_000_000_000 : value;
    const date = new Date((appleSeconds + APPLE_EPOCH_UNIX_SECONDS) * 1000);
    if (!Number.isFinite(date.getTime())) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages contains an out-of-range Apple timestamp");
    }
    return date.toISOString();
  }
  let raw: bigint;
  try {
    raw = BigInt(sqliteIntegerToken(value, "Apple timestamp"));
  } catch (error) {
    if (value === null || value === undefined || value === 0 || value === "0") return null;
    throw error;
  }
  if (raw <= 0n) return null;
  const unixMilliseconds = raw >= APPLE_NANOSECOND_THRESHOLD
    ? raw / NANOSECONDS_PER_MILLISECOND + BigInt(APPLE_EPOCH_UNIX_SECONDS) * MILLISECONDS_PER_SECOND
    : (raw + BigInt(APPLE_EPOCH_UNIX_SECONDS)) * MILLISECONDS_PER_SECOND;
  const date = new Date(Number(unixMilliseconds));
  if (!Number.isFinite(date.getTime())) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages contains an out-of-range Apple timestamp");
  }
  return date.toISOString();
}
