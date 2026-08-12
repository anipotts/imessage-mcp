import type { ServiceFamily } from "../contracts.js";
import { makeBudget } from "../contracts.js";
import type { DatabaseContext, DatabaseRequest } from "../database.js";
import { normalizeHandle } from "../contacts.js";
import { ImessageMcpError } from "../errors.js";
import { columnSql, serviceFamilyCase, serviceSql } from "../schema-sql.js";
import type { DateBounds } from "../time.js";
import {
  appleTimestampBoundary,
  appleTimestampBoundarySql,
  appleTimestampSortSql,
  appleTimestampToIso,
  appleUnixSecondsExpression,
} from "../time.js";
import { assertMessageConversationIntegrity } from "./conversations.js";

export type Metric = "message_count" | "response_time" | "streaks" | "initiation";

export interface AnalyticsScope {
  kind: "global" | "contact" | "conversation";
  handles?: string[];
  chatIds?: number[];
}

export interface AnalyticsResult {
  metric: Metric;
  formula: string;
  effective_timezone: string;
  date_range: { from: string | null; to_exclusive: string | null };
  applied_parameters: Record<string, unknown>;
  overall: Record<string, unknown>;
  service_partitions: Array<Record<string, unknown> & { service_family: ServiceFamily }>;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function canonicalConversationSql(request: DatabaseRequest, chatExpression: string): string {
  if (request.capabilities.chat_lookup !== "available") return chatExpression;
  return `mcp_canonical_chat(${chatExpression})`;
}

function filters(request: DatabaseRequest, scope: AnalyticsScope, bounds: DateBounds): { sql: string; bindings: unknown[] } {
  const where = ["m.ROWID <= ?"];
  const bindings: unknown[] = [request.asOf.max_message_id];
  if (scope.kind === "contact") {
    if (!scope.handles?.length) throw new ImessageMcpError("INVALID_INPUT", "contact analytics requires resolved handles");
  }
  if (scope.kind === "conversation") {
    if (!scope.chatIds?.length) {
      throw new ImessageMcpError("INVALID_INPUT", "conversation analytics requires a conversation reference");
    }
    where.push(`cmj.chat_id IN (${placeholders(scope.chatIds)})`);
    bindings.push(...scope.chatIds);
  }
  if (bounds.from_unix_seconds !== undefined) {
    const boundary = appleTimestampBoundary(bounds.from_unix_seconds);
    where.push(appleTimestampBoundarySql("m.date", ">=", "?", "?"));
    bindings.push(boundary.nanoseconds, boundary.seconds);
  }
  if (bounds.to_unix_seconds !== undefined) {
    const boundary = appleTimestampBoundary(bounds.to_unix_seconds);
    where.push(appleTimestampBoundarySql("m.date", "<", "?", "?"));
    bindings.push(boundary.nanoseconds, boundary.seconds);
  }
  return { sql: where.join(" AND "), bindings };
}

function baseCte(request: DatabaseRequest, scope: AnalyticsScope, bounds: DateBounds): { sql: string; bindings: unknown[] } {
  const filtered = filters(request, scope, bounds);
  const reactionType = columnSql(request, "message", "m", "associated_message_type", "0");
  const itemType = columnSql(request, "message", "m", "item_type", "0");
  const system = columnSql(request, "message", "m", "is_system_message", "0");
  const conversation = canonicalConversationSql(request, "cmj.chat_id");
  const family = serviceFamilyCase(serviceSql(request, "m", "c"));
  const contactHandles = scope.kind === "contact"
    ? [...new Set((scope.handles ?? []).map(normalizeHandle))]
    : [];
  const eligibleContactCte = scope.kind === "contact"
    ? `eligible_conversations AS (
        SELECT DISTINCT ${canonicalConversationSql(request, "participant.chat_id")} AS conversation_id
        FROM chat_handle_join participant
        JOIN handle participant_handle ON participant_handle.ROWID = participant.handle_id
        WHERE mcp_normalize_handle(participant_handle.id) IN (${placeholders(contactHandles)})
      ),`
    : "";
  const eligibleContactJoin = scope.kind === "contact"
    ? `JOIN eligible_conversations eligible ON eligible.conversation_id = ${conversation}`
    : "";
  return {
    sql: `WITH ${eligibleContactCte} raw_base AS (
      SELECT
        m.ROWID AS rowid,
        cmj.chat_id,
        ${conversation} AS conversation_id,
        m.is_from_me,
        ${appleTimestampSortSql("m.date")} AS raw_time,
        ${appleUnixSecondsExpression("m.date")} AS unix_time,
        ${family} AS service_family,
        COALESCE(${reactionType}, 0) AS reaction_type,
        COALESCE(${itemType}, 0) AS item_type,
        COALESCE(${system}, 0) AS is_system_message,
        CASE WHEN COALESCE(${reactionType}, 0) = 0
                   AND COALESCE(${itemType}, 0) = 0
                   AND COALESCE(${system}, 0) = 0
             THEN 1 ELSE 0 END AS is_user_message
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      ${eligibleContactJoin}
      WHERE ${filtered.sql}
    ), base AS (
      SELECT rowid, MIN(chat_id) AS chat_id, conversation_id,
             MAX(is_from_me) AS is_from_me, MIN(raw_time) AS raw_time, MIN(unix_time) AS unix_time,
             CASE WHEN COUNT(DISTINCT service_family) = 1
                  THEN MIN(service_family) ELSE 'unknown' END AS service_family,
             MAX(reaction_type) AS reaction_type, MAX(item_type) AS item_type,
             MAX(is_system_message) AS is_system_message, MAX(is_user_message) AS is_user_message
      FROM raw_base
      GROUP BY rowid, conversation_id
    )`,
    bindings: [...contactHandles, ...filtered.bindings],
  };
}

function messageCount(
  request: DatabaseRequest,
  scope: AnalyticsScope,
  bounds: DateBounds,
): Pick<AnalyticsResult, "overall" | "service_partitions"> {
  const base = baseCte(request, scope, bounds);
  const overall = request.db
    .prepare(`${base.sql}
      SELECT COALESCE(SUM(is_user_message), 0) AS messages,
             COALESCE(SUM(CASE WHEN is_user_message = 1 AND is_from_me = 1 THEN 1 ELSE 0 END), 0) AS sent,
             COALESCE(SUM(CASE WHEN is_user_message = 1 AND is_from_me = 0 THEN 1 ELSE 0 END), 0) AS received,
             COALESCE(SUM(CASE WHEN reaction_type BETWEEN 2000 AND 3999 THEN 1 ELSE 0 END), 0) AS reaction_events,
             COALESCE(SUM(CASE WHEN item_type <> 0 OR is_system_message = 1 THEN 1 ELSE 0 END), 0) AS system_events
      FROM base`)
    .get(...base.bindings) as Record<string, unknown>;
  const service = request.db
    .prepare(`${base.sql}
      SELECT service_family,
             SUM(is_user_message) AS messages,
             SUM(CASE WHEN is_user_message = 1 AND is_from_me = 1 THEN 1 ELSE 0 END) AS sent,
             SUM(CASE WHEN is_user_message = 1 AND is_from_me = 0 THEN 1 ELSE 0 END) AS received,
             SUM(CASE WHEN reaction_type BETWEEN 2000 AND 3999 THEN 1 ELSE 0 END) AS reaction_events,
             SUM(CASE WHEN item_type <> 0 OR is_system_message = 1 THEN 1 ELSE 0 END) AS system_events
      FROM base GROUP BY service_family ORDER BY service_family`)
    .all(...base.bindings) as AnalyticsResult["service_partitions"];
  return { overall, service_partitions: service };
}

function responseTime(
  request: DatabaseRequest,
  scope: AnalyticsScope,
  bounds: DateBounds,
): Pick<AnalyticsResult, "overall" | "service_partitions"> {
  const base = baseCte(request, scope, bounds);
  const participantConversation = canonicalConversationSql(request, "participant.chat_id");
  const chatConversation = canonicalConversationSql(request, "shape_chat.ROWID");
  const chatColumns = request.capabilities.tables.chat ?? [];
  const groupEvidence = [
    chatColumns.includes("style") ? "COALESCE(shape_chat.style, 0) = 43" : "0",
    chatColumns.includes("group_id") ? "COALESCE(shape_chat.group_id, '') <> ''" : "0",
    chatColumns.includes("display_name") ? "COALESCE(shape_chat.display_name, '') <> ''" : "0",
  ].join(" OR ");
  const cte = `${base.sql},
    participant_counts AS (
      SELECT ${participantConversation} AS conversation_id,
             COUNT(DISTINCT participant.handle_id) AS participant_count
      FROM chat_handle_join participant
      GROUP BY ${participantConversation}
    ),
    conversation_shapes AS (
      SELECT ${chatConversation} AS conversation_id,
             MAX(CASE WHEN ${groupEvidence} THEN 1 ELSE 0 END) AS group_evidence,
             ${chatColumns.includes("style")
               ? "MIN(CASE WHEN COALESCE(shape_chat.style, 0) = 45 THEN 1 ELSE 0 END)"
               : "0"} AS direct_evidence
      FROM chat shape_chat
      GROUP BY ${chatConversation}
    ),
    direct AS (
      SELECT b.*
      FROM base b
      LEFT JOIN participant_counts counts ON counts.conversation_id = b.conversation_id
      LEFT JOIN conversation_shapes shapes ON shapes.conversation_id = b.conversation_id
      WHERE b.is_user_message = 1
        AND COALESCE(shapes.group_evidence, 0) = 0
        AND (COALESCE(shapes.direct_evidence, 0) = 1 OR COALESCE(counts.participant_count, 0) <= 1)
    ),
    marked AS (
      SELECT *,
             CASE WHEN LAG(is_from_me) OVER (
                    PARTITION BY conversation_id ORDER BY raw_time, rowid
                  ) IS is_from_me THEN 0 ELSE 1 END AS new_turn
      FROM direct
    ),
    numbered AS (
      SELECT *,
             SUM(new_turn) OVER (
               PARTITION BY conversation_id ORDER BY raw_time, rowid
             ) AS turn_number
      FROM marked
    ),
    valued AS (
      SELECT *,
             FIRST_VALUE(service_family) OVER (
               PARTITION BY conversation_id, turn_number ORDER BY raw_time, rowid
             ) AS turn_service
      FROM numbered
    ),
    turns AS (
      SELECT conversation_id, turn_number, is_from_me, turn_service,
             MIN(unix_time) AS first_at, MAX(unix_time) AS last_at
      FROM valued
      GROUP BY conversation_id, turn_number, is_from_me, turn_service
    ),
    pairs AS (
      SELECT *,
             LEAD(first_at) OVER (
               PARTITION BY conversation_id ORDER BY turn_number
             ) - last_at AS response_seconds,
             LEAD(is_from_me) OVER (
               PARTITION BY conversation_id ORDER BY turn_number
             ) AS reply_from_me,
             LEAD(turn_service) OVER (
               PARTITION BY conversation_id ORDER BY turn_number
             ) AS reply_service
      FROM turns
    )`;
  const overall = request.db
    .prepare(`${cte}
      SELECT COUNT(response_seconds) AS samples,
             ROUND(AVG(response_seconds), 3) AS average_seconds,
             ROUND(MIN(response_seconds), 3) AS fastest_seconds,
             ROUND(MAX(response_seconds), 3) AS slowest_seconds,
             ROUND(AVG(CASE WHEN reply_from_me = 1 THEN response_seconds END), 3) AS my_average_seconds,
             ROUND(AVG(CASE WHEN reply_from_me = 0 THEN response_seconds END), 3) AS their_average_seconds
      FROM pairs WHERE response_seconds >= 0`)
    .get(...base.bindings) as Record<string, unknown>;
  const service = request.db
    .prepare(`${cte}
      SELECT reply_service AS service_family,
             COUNT(response_seconds) AS samples,
             ROUND(AVG(response_seconds), 3) AS average_seconds,
             ROUND(AVG(CASE WHEN reply_from_me = 1 THEN response_seconds END), 3) AS my_average_seconds,
             ROUND(AVG(CASE WHEN reply_from_me = 0 THEN response_seconds END), 3) AS their_average_seconds
      FROM pairs
      WHERE response_seconds >= 0 AND reply_service IS NOT NULL
      GROUP BY reply_service ORDER BY reply_service`)
    .all(...base.bindings) as AnalyticsResult["service_partitions"];
  return { overall, service_partitions: service };
}

function longestRun(days: string[]): number {
  let longest = 0;
  let current = 0;
  let previous: number | null = null;
  for (const day of days.sort()) {
    const serial = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
    current = previous !== null && serial === previous + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = serial;
  }
  return longest;
}

function streaks(
  request: DatabaseRequest,
  scope: AnalyticsScope,
  bounds: DateBounds,
): Pick<AnalyticsResult, "overall" | "service_partitions"> {
  const base = baseCte(request, scope, bounds);
  const rows = request.db
    .prepare(`${base.sql}
      SELECT service_family, local_day(CAST(raw_time AS TEXT)) AS day,
             MAX(CASE WHEN is_user_message = 1 AND is_from_me = 1 THEN 1 ELSE 0 END) AS sent,
             MAX(CASE WHEN is_user_message = 1 AND is_from_me = 0 THEN 1 ELSE 0 END) AS received
      FROM base
      WHERE is_user_message = 1
      GROUP BY service_family, day
      ORDER BY day`)
    .all(...base.bindings) as Array<{ service_family: ServiceFamily; day: string; sent: number; received: number }>;
  const overallDays = [...new Set(rows.map((row) => row.day))];
  const mutualByDay = new Map<string, { sent: boolean; received: boolean }>();
  for (const row of rows) {
    const current = mutualByDay.get(row.day) ?? { sent: false, received: false };
    current.sent ||= Boolean(row.sent);
    current.received ||= Boolean(row.received);
    mutualByDay.set(row.day, current);
  }
  const mutualDays = [...mutualByDay]
    .filter(([, value]) => value.sent && value.received)
    .map(([day]) => day);
  const servicePartitions = [...new Set(rows.map((row) => row.service_family))].map((family) => {
    const subset = rows.filter((row) => row.service_family === family);
    return {
      service_family: family,
      any_activity_longest_days: longestRun(subset.map((row) => row.day)),
      mutual_exchange_longest_days: longestRun(
        subset.filter((row) => row.sent && row.received).map((row) => row.day),
      ),
    };
  });
  return {
    overall: {
      any_activity_longest_days: longestRun(overallDays),
      mutual_exchange_longest_days: longestRun(mutualDays),
    },
    service_partitions: servicePartitions,
  };
}

function initiation(
  request: DatabaseRequest,
  scope: AnalyticsScope,
  bounds: DateBounds,
  gapHours: number,
): Pick<AnalyticsResult, "overall" | "service_partitions"> {
  const base = baseCte(request, scope, bounds);
  const gapSeconds = gapHours * 3600;
  const cte = `${base.sql},
    messages AS (SELECT * FROM base WHERE is_user_message = 1),
    marked AS (
      SELECT *,
             CASE WHEN LAG(unix_time) OVER (
                    PARTITION BY conversation_id ORDER BY raw_time, rowid
                  ) IS NULL
                       OR unix_time - LAG(unix_time) OVER (
                         PARTITION BY conversation_id ORDER BY raw_time, rowid
                       ) > ${gapSeconds}
                  THEN 1 ELSE 0 END AS starts_session
      FROM messages
    )`;
  const overall = request.db
    .prepare(`${cte}
      SELECT COALESCE(SUM(starts_session), 0) AS sessions,
             COALESCE(SUM(CASE WHEN starts_session = 1 AND is_from_me = 1 THEN 1 ELSE 0 END), 0) AS initiated_by_me,
             COALESCE(SUM(CASE WHEN starts_session = 1 AND is_from_me = 0 THEN 1 ELSE 0 END), 0) AS initiated_by_others,
             ROUND(100.0 * SUM(CASE WHEN starts_session = 1 AND is_from_me = 1 THEN 1 ELSE 0 END) /
               NULLIF(SUM(starts_session), 0), 3) AS my_initiation_percent
      FROM marked`)
    .get(...base.bindings) as Record<string, unknown>;
  const service = request.db
    .prepare(`${cte}
      SELECT service_family,
             SUM(starts_session) AS sessions,
             SUM(CASE WHEN starts_session = 1 AND is_from_me = 1 THEN 1 ELSE 0 END) AS initiated_by_me,
             SUM(CASE WHEN starts_session = 1 AND is_from_me = 0 THEN 1 ELSE 0 END) AS initiated_by_others,
             ROUND(100.0 * SUM(CASE WHEN starts_session = 1 AND is_from_me = 1 THEN 1 ELSE 0 END) /
               NULLIF(SUM(starts_session), 0), 3) AS my_initiation_percent
      FROM marked GROUP BY service_family ORDER BY service_family`)
    .all(...base.bindings) as AnalyticsResult["service_partitions"];
  return { overall, service_partitions: service };
}

export function analyze(input: {
  context: DatabaseContext;
  scope: AnalyticsScope;
  metric: Metric;
  bounds: DateBounds;
  sessionGapHours: number;
}): AnalyticsResult {
  const request = input.context.request();
  const budget = makeBudget(30_000, 1_000_000);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.bounds.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    request.db.function("local_day", { deterministic: true }, (appleTimestamp: string) => {
      const iso = appleTimestampToIso(appleTimestamp);
      if (!iso) throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "analytics encountered a missing message timestamp");
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    });
    const canonicalChats = assertMessageConversationIntegrity(request);
    request.db.function("mcp_canonical_chat", { deterministic: true }, (chatId: number) => {
      const numeric = Number(chatId);
      return canonicalChats.get(numeric) ?? numeric;
    });
    request.db.function("mcp_normalize_handle", { deterministic: true }, normalizeHandle);
    request.guard(budget);
    const values = input.metric === "message_count"
      ? messageCount(request, input.scope, input.bounds)
      : input.metric === "response_time"
        ? responseTime(request, input.scope, input.bounds)
        : input.metric === "streaks"
          ? streaks(request, input.scope, input.bounds)
          : initiation(request, input.scope, input.bounds, input.sessionGapHours);
    request.guard(budget);
    const formula = {
      message_count: "user message records, including attachment-only messages; reactions and system events reported separately",
      response_time: "direct linked conversations only; collapse consecutive same-sender messages into turns, then measure the last message to the first reply and partition by reply service",
      streaks: "longest consecutive local-calendar days for any activity and for days containing both sent and received messages",
      initiation: "first message after the configured conversation session gap; default gap is eight hours",
    }[input.metric];
    return {
      metric: input.metric,
      formula,
      effective_timezone: input.bounds.timezone,
      date_range: {
        from: input.bounds.from_unix_seconds !== undefined
          ? new Date(input.bounds.from_unix_seconds * 1000).toISOString()
          : null,
        to_exclusive: input.bounds.to_unix_seconds !== undefined
          ? new Date(input.bounds.to_unix_seconds * 1000).toISOString()
          : null,
      },
      applied_parameters: {
        scope: input.scope.kind,
        ...(input.metric === "initiation" ? { session_gap_hours: input.sessionGapHours } : {}),
      },
      ...values,
    };
  } finally {
    request.close();
  }
}
