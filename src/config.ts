import { release, userInfo } from "node:os";
import path from "node:path";
import type { PrivacyMode } from "./contracts.js";
import { ImessageMcpError } from "./errors.js";

export type TransportKind = "stdio" | "http";

export interface RuntimeConfig {
  database_path: string;
  source_mode: "live" | "copy";
  contacts_mode: "live" | "none";
  privacy_ceiling: PrivacyMode;
  transport: TransportKind;
  port: number;
}

/**
 * Deliberately reads the OS account rather than `$HOME`: this path decides
 * whether a database counts as live, and a redirected environment must not be
 * able to pass a copy off as the account's own Messages store.
 */
export function resolveDefaultDatabasePath(): string {
  return path.join(userInfo().homedir, "Library", "Messages", "chat.db");
}

export const DEFAULT_DATABASE_PATH = resolveDefaultDatabasePath();

export interface DatabaseSelection {
  path: string;
  sourceMode: "live" | "copy";
}

export function resolveDatabaseSelection(databasePath?: string): DatabaseSelection {
  const configured = databasePath ?? process.env.IMESSAGE_DB;
  const resolved = path.resolve(configured ?? DEFAULT_DATABASE_PATH);
  return { path: resolved, sourceMode: resolved === path.resolve(DEFAULT_DATABASE_PATH) ? "live" : "copy" };
}

function parsePrivacy(value: string | undefined, fallback: PrivacyMode): PrivacyMode {
  if (!value) return fallback;
  if (value === "full" || value === "redacted" || value === "aggregate") return value;
  throw new ImessageMcpError("INVALID_INPUT", "privacy mode must be full, redacted, or aggregate");
}

export function runtimeConfig(input: {
  databasePath?: string;
  contacts?: string;
  privacy?: string;
  transport: TransportKind;
  port?: number;
}): RuntimeConfig {
  if (process.platform !== "darwin") {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "imessage-mcp reads Apple Messages and requires macOS");
  }
  const darwinMajor = Number(release().split(".")[0]);
  if (!Number.isSafeInteger(darwinMajor) || darwinMajor < 23) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "imessage-mcp requires macOS 14 or newer");
  }
  const selection = resolveDatabaseSelection(input.databasePath);
  const contactsRaw = input.contacts ?? process.env.IMESSAGE_CONTACTS;
  if (contactsRaw && contactsRaw !== "live" && contactsRaw !== "none") {
    throw new ImessageMcpError("INVALID_INPUT", "contacts must be live or none");
  }
  if (selection.sourceMode === "copy" && contactsRaw === "live") {
    throw new ImessageMcpError(
      "INVALID_INPUT",
      "copied databases cannot be paired with this Mac's live Contacts; use handles with --contacts none",
    );
  }
  const port = input.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ImessageMcpError("INVALID_INPUT", "port must be an integer between 1 and 65535");
  }
  return {
    database_path: selection.path,
    source_mode: selection.sourceMode,
    contacts_mode: selection.sourceMode === "live" && contactsRaw !== "none" ? "live" : "none",
    privacy_ceiling: parsePrivacy(input.privacy ?? process.env.IMESSAGE_PRIVACY, input.transport === "http" ? "redacted" : "full"),
    transport: input.transport,
    port,
  };
}
