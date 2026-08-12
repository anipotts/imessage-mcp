import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { ImessageMcpError } from "./errors.js";

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
          `${input.label} file must be an operator-owned 0600 regular file`,
        );
      }
      value = readFileSync(descriptor, "utf8").replace(/\r?\n$/u, "");
    } catch (error) {
      if (error instanceof ImessageMcpError) throw error;
      throw new ImessageMcpError("INVALID_INPUT", `${input.label} file could not be opened safely`);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
  if (value === null) {
    if (!input.required) return null;
    throw new ImessageMcpError(
      "INVALID_INPUT",
      `${input.label} requires ${input.directName} or ${input.fileName}`,
    );
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > 4096) {
    throw new ImessageMcpError("INVALID_INPUT", `${input.label} must not exceed 4096 bytes`);
  }
  if (encoded.length < 32) {
    throw new ImessageMcpError("INVALID_INPUT", `${input.label} must contain at least 32 random bytes`);
  }
  return encoded;
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
