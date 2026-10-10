import { ImessageMcpError } from "../src/errors.js";
import { assertNoForbiddenFields } from "../src/privacy.js";

const PHASES = [
  "source", "sampling", "decoding", "contacts", "tool_setup",
  "tool_server_status", "tool_resolve_contact", "tool_list_conversations",
  "tool_get_conversation", "tool_analyze_communication", "tool_sync_messages",
  "tool_search_messages", "aggregate_privacy", "latency", "cleanup",
] as const;
export type ParityPhase = typeof PHASES[number];
export type MarkParityPhase = (phase: ParityPhase) => void;

const CHECK_REASONS = [
  "PARITY_FAILED", "TOOL_FAILED", "DECODE_PARITY_FAILED", "AGGREGATE_PRIVACY_FAILED",
] as const;
type CheckReason = typeof CHECK_REASONS[number];
const SOURCE_REASONS = [
  "INVALID_INPUT", "AMBIGUOUS_CONTACT", "PRIVACY_RESTRICTED", "DATABASE_UNAVAILABLE",
  "DATABASE_CHANGED", "UNSUPPORTED_SCHEMA", "DECODE_FAILED", "INDEX_TOO_LARGE",
  "INDEX_BUILDING", "QUERY_BUDGET_EXCEEDED",
] as const;

export class ParityFailure extends Error {
  constructor(readonly reason: CheckReason) {
    super(reason);
    this.name = "ParityFailure";
  }
}

// Failures never carry an assertion's actual/expected values, source path, stack,
// tool error details, or decoder input. Only allowlisted metadata reaches stderr.
function failureReason(error: unknown): string {
  try {
    if (error instanceof ParityFailure) {
      const candidate = error.reason;
      const known = CHECK_REASONS.find((reason) => reason === candidate);
      if (known) return known;
    }
    if (error instanceof ImessageMcpError) {
      const candidate = error.reason;
      const known = SOURCE_REASONS.find((reason) => reason === candidate);
      if (known) return known;
    }
  } catch {
    // Even malformed error objects cannot fall back to native error formatting.
  }
  return "PARITY_FAILED";
}

export async function runParitySafely(
  operation: (markPhase: MarkParityPhase) => Promise<Record<string, unknown>>,
  output: { stdout: (line: string) => void; stderr: (line: string) => void },
): Promise<0 | 1> {
  let phase: ParityPhase = "source";
  try {
    const summary = await operation((next) => {
      if (PHASES.some((known) => known === next)) phase = next;
    });
    output.stdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    const failure = { status: "failed", phase, reason: failureReason(error), private_values_emitted: 0 };
    try {
      output.stderr(`${JSON.stringify(failure)}\n`);
    } catch {
      // A closed diagnostic stream must not turn the original error into an
      // uncaught exception whose default formatting exposes source values.
    }
    return 1;
  }
}

export function assertAggregateParity(payload: unknown, privateProbe: string): void {
  try {
    // Keep this check aligned with the actual aggregate privacy contract,
    // including chat_ids, previous_chat_ids, conversation_ids and parent ids.
    assertNoForbiddenFields(payload, "aggregate");
  } catch {
    throw new ParityFailure("AGGREGATE_PRIVACY_FAILED");
  }
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== "string" || serialized.includes(privateProbe) || /"query"\s*:/u.test(serialized)) {
    throw new ParityFailure("AGGREGATE_PRIVACY_FAILED");
  }
}
