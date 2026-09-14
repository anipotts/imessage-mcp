import { homedir, release } from "node:os";
import path from "node:path";
import type { PrivacyMode } from "./contracts.js";
import { ImessageMcpError } from "./errors.js";
import { resolveDatabaseId, resolveReferenceKey, type ResolvedSecret, type SecretSource } from "./keys.js";

export type TransportKind = "stdio" | "http";

export interface RuntimeConfig {
  database_path: string;
  source_mode: "live" | "copy";
  contacts_mode: "live" | "none";
  privacy_ceiling: PrivacyMode;
  transport: TransportKind;
  port: number;
  attachment_paths_enabled: boolean;
  reference_key: string | null;
  database_id: string | null;
  reference_key_source?: SecretSource;
  database_id_source?: SecretSource;
}

export function resolveDefaultDatabasePath(): string {
  return path.join(homedir(), "Library", "Messages", "chat.db");
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
  attachmentPaths?: boolean;
  referenceKey?: Buffer;
  databaseId?: Buffer;
}): RuntimeConfig {
  if (process.platform !== "darwin") {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "imessage-mcp 2.x requires macOS");
  }
  const darwinMajor = Number(release().split(".")[0]);
  if (!Number.isSafeInteger(darwinMajor) || darwinMajor < 23) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "imessage-mcp 2.x requires macOS 14 or newer");
  }
  if (process.env.IMESSAGE_SAFE_MODE !== undefined) {
    throw new ImessageMcpError(
      "INVALID_INPUT",
      "IMESSAGE_SAFE_MODE was removed in 2.0; use IMESSAGE_PRIVACY=redacted",
    );
  }
  if (process.env.IMESSAGE_SYNC !== undefined) {
    throw new ImessageMcpError(
      "INVALID_INPUT",
      "IMESSAGE_SYNC was removed in 2.0; call sync_messages with a caller-held cursor",
    );
  }

  const selection = resolveDatabaseSelection(input.databasePath);
  const databasePath = selection.path;
  const sourceMode = selection.sourceMode;
  const contactsRaw = input.contacts ?? process.env.IMESSAGE_CONTACTS;
  if (contactsRaw && contactsRaw !== "live" && contactsRaw !== "none") {
    throw new ImessageMcpError("INVALID_INPUT", "contacts must be live or none");
  }
  if (sourceMode === "copy" && contactsRaw === "live") {
    throw new ImessageMcpError(
      "INVALID_INPUT",
      "copied databases cannot be paired with this Mac's live Contacts; use handles with --contacts none",
    );
  }
  const contactsMode = sourceMode === "live" && contactsRaw !== "none" ? "live" : "none";

  const defaultPrivacy: PrivacyMode = input.transport === "http" ? "redacted" : "full";
  const port = input.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ImessageMcpError("INVALID_INPUT", "port must be an integer between 1 and 65535");
  }
  const attachmentEnvironment = process.env.IMESSAGE_ATTACHMENT_PATHS;
  if (attachmentEnvironment !== undefined && attachmentEnvironment !== "0" && attachmentEnvironment !== "1") {
    throw new ImessageMcpError("INVALID_INPUT", "IMESSAGE_ATTACHMENT_PATHS must be 0 or 1");
  }
  const referenceKey: ResolvedSecret = input.referenceKey
    ? { value: input.referenceKey, source: "caller" }
    : resolveReferenceKey();
  const databaseId: ResolvedSecret = input.databaseId
    ? { value: input.databaseId, source: "caller" }
    : resolveDatabaseId(databasePath, sourceMode);
  if (referenceKey.value.equals(databaseId.value)) {
    throw new ImessageMcpError(
      "INVALID_INPUT",
      "opaque-reference key and database-lineage identity must be generated independently",
    );
  }

  return {
    database_path: databasePath,
    source_mode: sourceMode,
    contacts_mode: contactsMode,
    privacy_ceiling: parsePrivacy(input.privacy ?? process.env.IMESSAGE_PRIVACY, defaultPrivacy),
    transport: input.transport,
    port,
    attachment_paths_enabled: input.attachmentPaths ?? attachmentEnvironment === "1",
    reference_key: referenceKey.value.toString("base64"),
    database_id: databaseId.value.toString("base64"),
    reference_key_source: referenceKey.source,
    database_id_source: databaseId.source,
  };
}
