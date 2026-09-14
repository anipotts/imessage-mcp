import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync, type Stats } from "node:fs";
import { homedir } from "node:os";
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

export function defaultStateDirectory(): string {
  return path.join(homedir(), "Library", "Application Support", "imessage-mcp");
}

export function stateDirectory(): string {
  const override = process.env.IMESSAGE_STATE_DIR;
  if (override !== undefined && override !== "") return path.resolve(override);
  return defaultStateDirectory();
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

export interface StateRepair {
  name: string;
  status: "pass" | "warn";
  detail: string;
}

interface SecretTarget {
  name: string;
  label: string;
  directVariable: string;
  fileVariable: string;
  fileName: (databasePath: string, sourceMode: "live" | "copy") => string;
}

const SECRET_TARGETS: SecretTarget[] = [
  {
    name: "reference_key",
    label: REFERENCE_KEY_LABEL,
    directVariable: "IMESSAGE_REFERENCE_KEY",
    fileVariable: "IMESSAGE_REFERENCE_KEY_FILE",
    fileName: () => "reference-key",
  },
  {
    name: "database_id",
    label: DATABASE_ID_LABEL,
    directVariable: "IMESSAGE_DATABASE_ID",
    fileVariable: "IMESSAGE_DATABASE_ID_FILE",
    fileName: databaseIdFileName,
  },
];

function ownedByCaller(stat: Stats): boolean {
  return !process.getuid || stat.uid === process.getuid();
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * Canonical spelling of a path, with symbolic links resolved. `path.resolve`
 * alone leaves two spellings of one file looking unrelated, which matters on
 * macOS where `/tmp`, `/var`, and `/etc` are all links. A path that does not
 * exist yet is canonicalized through its parent directory so a file named by
 * an environment variable still compares equal once it appears.
 */
export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    // the path does not exist yet, so canonicalize the directory around it
  }
  try {
    return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

export function environmentSecretFiles(): Set<string> {
  const files = new Set<string>();
  for (const name of ["IMESSAGE_REFERENCE_KEY_FILE", "IMESSAGE_DATABASE_ID_FILE", "IMESSAGE_API_TOKEN_FILE"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") files.add(canonicalPath(value));
  }
  return files;
}

/**
 * Creates missing default key files and restores owner-only modes. It never
 * touches a file named by an IMESSAGE_*_FILE variable, and it never changes
 * Full Disk Access or Contacts authorization.
 */
export function repairDefaultState(databasePath: string, sourceMode: "live" | "copy"): StateRepair[] {
  const repairs: StateRepair[] = [];
  const directory = stateDirectory();
  const reserved = environmentSecretFiles();
  let usable = false;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) {
      repairs.push({ name: "state_dir", status: "warn", detail: `${directory} is not a directory; move it aside and run doctor --fix again` });
    } else if (!ownedByCaller(stat)) {
      repairs.push({ name: "state_dir", status: "warn", detail: `${directory} belongs to another user and was left unchanged` });
    } else {
      usable = true;
      const mode = stat.mode & 0o777;
      if (mode === 0o700) {
        repairs.push({ name: "state_dir", status: "pass", detail: `${directory} already has mode 0700` });
      } else {
        chmodSync(directory, 0o700);
        repairs.push({ name: "state_dir", status: "pass", detail: `${directory} mode changed from ${octal(mode)} to 0700` });
      }
    }
  } catch {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      usable = true;
      repairs.push({ name: "state_dir", status: "pass", detail: `${directory} created with mode 0700` });
    } catch {
      repairs.push({ name: "state_dir", status: "warn", detail: `${directory} could not be created` });
    }
  }
  if (!usable) return repairs;

  for (const target of SECRET_TARGETS) {
    if (process.env[target.directVariable] !== undefined || process.env[target.fileVariable] !== undefined) {
      repairs.push({
        name: target.name,
        status: "pass",
        detail: "configured by the environment; the default file was neither created nor changed",
      });
      continue;
    }
    const file = path.join(directory, target.fileName(databasePath, sourceMode));
    if (reserved.has(canonicalPath(file))) {
      repairs.push({ name: target.name, status: "warn", detail: "named by an IMESSAGE_*_FILE variable and left unchanged" });
      continue;
    }
    let stat: Stats | null = null;
    try {
      stat = lstatSync(file);
    } catch {
      stat = null;
    }
    if (stat === null) {
      try {
        generateDefaultFile(file, target.label);
        repairs.push({ name: target.name, status: "pass", detail: `${file} created with mode 0600` });
      } catch {
        repairs.push({ name: target.name, status: "warn", detail: `${file} could not be created` });
      }
      continue;
    }
    if (!stat.isFile()) {
      repairs.push({ name: target.name, status: "warn", detail: `${file} is not a regular file and was left unchanged` });
      continue;
    }
    if (!ownedByCaller(stat)) {
      repairs.push({ name: target.name, status: "warn", detail: `${file} belongs to another user and was left unchanged` });
      continue;
    }
    const mode = stat.mode & 0o777;
    if (mode === 0o600) {
      repairs.push({ name: target.name, status: "pass", detail: `${file} already has mode 0600` });
      continue;
    }
    try {
      chmodSync(file, 0o600);
      repairs.push({ name: target.name, status: "pass", detail: `${file} mode changed from ${octal(mode)} to 0600` });
    } catch {
      repairs.push({ name: target.name, status: "warn", detail: `${file} mode could not be changed` });
    }
  }
  repairs.push({
    name: "permissions",
    status: "pass",
    detail: "Full Disk Access and Contacts were not touched; grant them in System Settings > Privacy & Security",
  });
  return repairs;
}
