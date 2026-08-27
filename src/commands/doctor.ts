import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "../config.js";
import { DatabaseContext } from "../database.js";
import { MessageTextDecoder } from "../decoder.js";
import { UnifiedContactResolver } from "../contacts.js";
import { validateHttpConfiguration } from "../transport.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export async function doctor(config: RuntimeConfig, json: boolean): Promise<number> {
  const checks: DoctorCheck[] = [];
  try {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      mcpName?: string;
    };
    const serverJson = JSON.parse(readFileSync(join(packageRoot, "server.json"), "utf8")) as {
      version?: string;
      packages?: Array<{ version?: string }>;
    };
    const valid = packageJson.name === "imessage-mcp" &&
      /^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version ?? "") &&
      packageJson.mcpName === "io.github.anipotts/imessage-mcp" &&
      serverJson.version === packageJson.version &&
      serverJson.packages?.[0]?.version === packageJson.version &&
      existsSync(join(packageRoot, "native", "message-text-decoder.js"));
    checks.push({
      name: "package",
      status: valid ? "pass" : "fail",
      detail: valid ? `package metadata is consistent at ${packageJson.version}` : "installed package metadata is incomplete or inconsistent",
    });
  } catch {
    checks.push({ name: "package", status: "fail", detail: "installed package metadata could not be verified" });
  }
  checks.push({ name: "platform", status: process.platform === "darwin" ? "pass" : "fail", detail: process.platform === "darwin" ? "macOS detected" : "macOS is required" });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeSupported = [22, 24, 26].includes(nodeMajor);
  checks.push({
    name: "node",
    status: nodeSupported ? "pass" : "fail",
    detail: nodeSupported ? `supported Node ${process.versions.node}` : `Node ${process.versions.node}; use active Node 22, 24, or 26`,
  });
  try {
    accessSync(config.database_path, constants.R_OK);
    checks.push({ name: "database_read", status: "pass", detail: "database is readable" });
  } catch {
    checks.push({ name: "database_read", status: "fail", detail: "grant Full Disk Access to the MCP client and confirm Messages has created chat.db" });
  }
  let canonicalDatabasePath = config.database_path;
  let schemaCheck: DoctorCheck;
  try {
    const database = new DatabaseContext(
      config.database_path,
      config.reference_key ? Buffer.from(config.reference_key, "base64") : Buffer.alloc(32, 0x5a),
      config.database_id ? Buffer.from(config.database_id, "base64") : Buffer.alloc(32, 0x6b),
      config.source_mode,
    );
    try {
      canonicalDatabasePath = database.canonicalPath;
      schemaCheck = { name: "schema", status: database.capabilities.required_core === "available" ? "pass" : "fail", detail: `schema ${database.capabilities.schema_fingerprint.slice(0, 12)}` };
    } finally {
      database.close();
    }
  } catch {
    schemaCheck = { name: "schema", status: "fail", detail: "unsupported or unavailable Mac chat.db schema" };
  }
  const walPath = `${canonicalDatabasePath}-wal`;
  if (existsSync(walPath)) {
    try {
      accessSync(walPath, constants.R_OK);
      checks.push({ name: "wal_read", status: "pass", detail: "active WAL is readable" });
    } catch {
      checks.push({ name: "wal_read", status: "fail", detail: "active Messages WAL is not readable" });
    }
  } else {
    checks.push({ name: "wal_read", status: "pass", detail: "no active WAL is present" });
  }
  checks.push(schemaCheck);
  if (config.contacts_mode === "none") {
    checks.push({ name: "contacts", status: "pass", detail: "disabled by --contacts none; using handles only" });
  } else {
    const contacts = new UnifiedContactResolver(true).status();
    checks.push({ name: "contacts", status: contacts.state === "available" ? "pass" : "warn", detail: contacts.state === "available" ? `${contacts.count} unified contacts available` : `continuing with handles: ${contacts.reason}` });
  }
  const decoder = new MessageTextDecoder();
  checks.push({ name: "decoder", status: await decoder.selfTest() ? "pass" : "fail", detail: decoder.healthState() === "healthy" ? "Foundation decoder self-test passed" : "Foundation decoder self-test failed" });
  checks.push({
    name: "reference_key",
    status: config.reference_key ? "pass" : "fail",
    detail: config.reference_key
      ? "stable opaque-reference authentication is configured"
      : "configure IMESSAGE_REFERENCE_KEY or an operator-owned 0600 IMESSAGE_REFERENCE_KEY_FILE",
  });
  checks.push({
    name: "database_id",
    status: config.database_id ? "pass" : "fail",
    detail: config.database_id
      ? "operator-controlled database lineage is configured"
      : "configure IMESSAGE_DATABASE_ID or an operator-owned 0600 IMESSAGE_DATABASE_ID_FILE",
  });
  if (config.transport === "http") {
    try {
      validateHttpConfiguration();
      checks.push({ name: "http_auth", status: "pass", detail: "bearer token source and Host/Origin allowlists are valid" });
    } catch {
      checks.push({ name: "http_auth", status: "fail", detail: "configure one 32-byte token source; token files must be operator-owned regular files with mode 0600" });
    }
  }
  const output = { status: checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "pass", source_mode: config.source_mode, privacy_ceiling: config.privacy_ceiling, checks };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  else {
    process.stdout.write(`imessage-mcp doctor: ${output.status}\n`);
    for (const check of checks) process.stdout.write(`${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`);
  }
  return output.status === "fail" ? 1 : 0;
}
