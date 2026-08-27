import type { ErrorReason } from "./contracts.js";

export class ImessageMcpError extends Error {
  readonly reason: ErrorReason;
  readonly details?: Record<string, unknown>;

  constructor(reason: ErrorReason, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ImessageMcpError";
    this.reason = reason;
    this.details = details;
  }
}

export function asImessageMcpError(error: unknown): ImessageMcpError {
  if (error instanceof ImessageMcpError) return error;
  return new ImessageMcpError("DATABASE_UNAVAILABLE", "the requested operation could not be completed");
}

export function assertInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ImessageMcpError("INVALID_INPUT", message);
}
