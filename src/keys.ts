import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { ImessageMcpError } from "./errors.js";
import { loadDatabaseId, loadReferenceKey, readSecretFile, validateSecretValue } from "./secrets.js";

export type SecretSource = "caller" | "environment" | "environment file" | "default file";

export interface ResolvedSecret {
  value: Buffer;
  source: SecretSource;
}

const REFERENCE_KEY_LABEL = "opaque-reference key";
const DATABASE_ID_LABEL = "database-lineage identity";

export function stateDirectory(): string {
  const override = process.env.IMESSAGE_STATE_DIR;
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(userInfo().homedir, "Library", "Application Support", "imessage-mcp");
}

export function databaseIdFileName(databasePath: string, sourceMode: "live" | "copy"): string {
  if (sourceMode === "live") return "database-id";
  const lineage = createHash("sha256").update(path.resolve(databasePath)).digest("hex").slice(0, 16);
  return `database-id-${lineage}`;
}

function loadDefaultFile(file: string, label: string): Buffer {
  return validateSecretValue(readSecretFile(file, label), label);
}

function generateDefaultFile(file: string, label: string): Buffer {
  const directory = path.dirname(file);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `${label} state directory could not be created`);
  }
  const value = randomBytes(32).toString("base64");
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadDefaultFile(file, label);
    throw new ImessageMcpError("INVALID_INPUT", `${label} could not be generated in the state directory`);
  }
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, `${value}\n`);
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `${label} could not be generated in the state directory`);
  } finally {
    closeSync(descriptor);
  }
  return validateSecretValue(value, label);
}

function defaultSecret(fileName: string, label: string): Buffer {
  const file = path.join(stateDirectory(), fileName);
  return existsSync(file) ? loadDefaultFile(file, label) : generateDefaultFile(file, label);
}

export function resolveReferenceKey(): ResolvedSecret {
  const configured = loadReferenceKey(false);
  if (configured) {
    return {
      value: configured,
      source: process.env.IMESSAGE_REFERENCE_KEY !== undefined ? "environment" : "environment file",
    };
  }
  return { value: defaultSecret("reference-key", REFERENCE_KEY_LABEL), source: "default file" };
}

export function resolveDatabaseId(databasePath: string, sourceMode: "live" | "copy"): ResolvedSecret {
  const configured = loadDatabaseId(false);
  if (configured) {
    return {
      value: configured,
      source: process.env.IMESSAGE_DATABASE_ID !== undefined ? "environment" : "environment file",
    };
  }
  return {
    value: defaultSecret(databaseIdFileName(databasePath, sourceMode), DATABASE_ID_LABEL),
    source: "default file",
  };
}
