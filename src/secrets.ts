import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { ImessageMcpError } from "./errors.js";

export function readSecretFile(file: string, label: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > 4096
    ) {
      throw new ImessageMcpError(
        "INVALID_INPUT",
        `${label} file must be an operator-owned 0600 regular file`,
      );
    }
    return readFileSync(descriptor, "utf8").replace(/\r?\n$/u, "");
  } catch (error) {
    if (error instanceof ImessageMcpError) throw error;
    throw new ImessageMcpError("INVALID_INPUT", `${label} file could not be opened safely`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function validateSecretValue(value: string, label: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > 4096) {
    throw new ImessageMcpError("INVALID_INPUT", `${label} must not exceed 4096 bytes`);
  }
  if (encoded.length < 32) {
    throw new ImessageMcpError("INVALID_INPUT", `${label} must contain at least 32 random bytes`);
  }
  return encoded;
}

function operatorSecret(input: {
  directName: string;
  fileName: string;
  label: string;
  required: boolean;
}): Buffer | null {
  const direct = process.env[input.directName];
  const file = process.env[input.fileName];
  if (direct !== undefined && file !== undefined) {
    throw new ImessageMcpError("INVALID_INPUT", `set only one ${input.label} source`);
  }
  let value: string | null = null;
  if (direct !== undefined) {
    value = direct;
  } else if (file !== undefined) {
    value = readSecretFile(file, input.label);
  }
  if (value === null) {
    if (!input.required) return null;
    throw new ImessageMcpError(
      "INVALID_INPUT",
      `${input.label} requires ${input.directName} or ${input.fileName}`,
    );
  }
  return validateSecretValue(value, input.label);
}

export function loadApiToken(required = true): Buffer | null {
  return operatorSecret({
    directName: "IMESSAGE_API_TOKEN",
    fileName: "IMESSAGE_API_TOKEN_FILE",
    label: "HTTP API token",
    required,
  });
}

export function loadReferenceKey(required = true): Buffer | null {
  return operatorSecret({
    directName: "IMESSAGE_REFERENCE_KEY",
    fileName: "IMESSAGE_REFERENCE_KEY_FILE",
    label: "opaque-reference key",
    required,
  });
}

export function loadDatabaseId(required = true): Buffer | null {
  return operatorSecret({
    directName: "IMESSAGE_DATABASE_ID",
    fileName: "IMESSAGE_DATABASE_ID_FILE",
    label: "database-lineage identity",
    required,
  });
}
