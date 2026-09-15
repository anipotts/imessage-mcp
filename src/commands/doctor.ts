import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "../config.js";
import { stateDirectory, type SecretSource, type StateRepair } from "../keys.js";
import { DatabaseContext, FULL_DISK_ACCESS_MESSAGE } from "../database.js";
import { MessageTextDecoder } from "../decoder.js";
import { UnifiedContactResolver } from "../contacts.js";
import { estimateSearchIndexFloor, searchIndexMemoryLimit } from "../search-index.js";
import { validateHttpConfiguration } from "../transport.js";
import { checkForUpdate } from "../update-check.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

const MIB = 1024 * 1024;
const SEARCH_INDEX_WARN_RATIO = 0.9;

function formatBytes(value: number): string {
  return value >= MIB ? `${(value / MIB).toFixed(1)} MiB` : `${value} bytes`;
}

function searchIndexCapacity(database: DatabaseContext, limitBytes: number): DoctorCheck {
  const request = database.request();
  try {
    const estimate = estimateSearchIndexFloor(request);
    const status = estimate.estimated_bytes > limitBytes
      ? "fail"
      : estimate.estimated_bytes >= limitBytes * SEARCH_INDEX_WARN_RATIO
        ? "warn"
        : "pass";
    const comparison = `${estimate.rows} indexable messages need at least ${formatBytes(estimate.estimated_bytes)} ` +
      `against the ${formatBytes(limitBytes)} in-memory search ceiling`;
    return {
      name: "search_index_capacity",
      status,
      detail: status === "pass"
        ? comparison
        : `${comparison}; search_messages ${status === "fail" ? "will" : "may"} fail with INDEX_TOO_LARGE`,
    };
  } finally {
    request.close();
  }
}

export async function doctor(
  config: RuntimeConfig,
  json: boolean,
  repairs: StateRepair[] = [],
  // Internal seam so tests can exercise the capacity check against a small
  // synthetic archive. The CLI never sets it and always uses the real ceiling.
  options: { searchIndexMemoryLimitBytes?: number } = {},
): Promise<number> {
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
    if (packageJson.version) {
      const update = await checkForUpdate(packageJson.version);
      checks.push({
        name: "update",
        status: update.status === "available" ? "warn" : "pass",
        detail: update.status === "available"
          ? `${update.latest_version} is available (running ${update.current_version}). ${update.how_to_update} Bundle: ${update.download_url}`
          : update.status === "current"
            ? `running the latest release, ${update.current_version}`
            : update.status === "disabled"
              ? "update check is off (IMESSAGE_UPDATE_CHECK=0)"
              : "could not reach the npm registry to check for a newer release",
      });
    }
  } catch {
    checks.push({ name: "package", status: "fail", detail: "installed package metadata could not be verified" });
  }
  checks.push({ name: "platform", status: process.platform === "darwin" ? "pass" : "fail", detail: process.platform === "darwin" ? "macOS detected" : "macOS is required" });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeSupported = nodeMajor >= 22;
  checks.push({
    name: "node",
    status: nodeSupported ? "pass" : "fail",
    detail: nodeSupported ? `supported Node ${process.versions.node}` : `Node ${process.versions.node}; requires Node 22 or newer`,
  });
  try {
    accessSync(config.database_path, constants.R_OK);
    checks.push({ name: "database_read", status: "pass", detail: "database is readable" });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    checks.push({
      name: "database_read",
      status: "fail",
      detail: code === "ENOENT"
        ? "Messages database was not found; open Messages on this Mac once so it creates its history"
        : FULL_DISK_ACCESS_MESSAGE,
    });
  }
  let canonicalDatabasePath = config.database_path;
  let schemaCheck: DoctorCheck;
  let capacityCheck: DoctorCheck = {
    name: "search_index_capacity",
    status: "warn",
    detail: "the search index size could not be estimated without a readable schema",
  };
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
      try {
        capacityCheck = searchIndexCapacity(database, options.searchIndexMemoryLimitBytes ?? searchIndexMemoryLimit());
      } catch {
        capacityCheck = {
          name: "search_index_capacity",
          status: "warn",
          detail: "the search index size could not be estimated from this archive",
        };
      }
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
  checks.push(capacityCheck);
  if (config.contacts_mode === "none") {
    checks.push({ name: "contacts", status: "pass", detail: "disabled by --contacts none; using handles only" });
  } else {
    const contacts = new UnifiedContactResolver(true).status();
    checks.push({ name: "contacts", status: contacts.state === "available" ? "pass" : "warn", detail: contacts.state === "available" ? `${contacts.count} unified contacts available` : `continuing with handles: ${contacts.reason}` });
  }
  const decoder = new MessageTextDecoder();
  checks.push({ name: "decoder", status: await decoder.selfTest() ? "pass" : "fail", detail: decoder.healthState() === "healthy" ? "Foundation decoder self-test passed" : "Foundation decoder self-test failed" });
  const stateDirectoryPath = stateDirectory();
  const describeSource = (source: SecretSource | undefined): string => {
    if (source === "default file") return `default file in ${stateDirectoryPath}`;
    if (source === "environment" || source === "environment file") return source;
    return "the calling process";
  };
  checks.push({
    name: "reference_key",
    status: config.reference_key ? "pass" : "fail",
    detail: config.reference_key
      ? `stable opaque-reference authentication is configured from ${describeSource(config.reference_key_source)}`
      : "configure IMESSAGE_REFERENCE_KEY or an operator-owned 0600 IMESSAGE_REFERENCE_KEY_FILE",
  });
  checks.push({
    name: "database_id",
    status: config.database_id ? "pass" : "fail",
    detail: config.database_id
      ? `database lineage identity is configured from ${describeSource(config.database_id_source)}`
      : "configure IMESSAGE_DATABASE_ID or an operator-owned 0600 IMESSAGE_DATABASE_ID_FILE",
  });
  try {
    const stateStat = statSync(stateDirectoryPath);
    const mode = stateStat.mode & 0o777;
    const owned = !process.getuid || stateStat.uid === process.getuid();
    const secure = stateStat.isDirectory() && mode === 0o700 && owned;
    checks.push({
      name: "state_dir",
      status: secure ? "pass" : "warn",
      detail: secure
        ? `${stateDirectoryPath} is owner-only with mode 0700`
        : `${stateDirectoryPath} has mode 0${mode.toString(8).padStart(3, "0")}; restrict it to the owner with chmod 700`,
    });
  } catch {
    checks.push({
      name: "state_dir",
      status: "warn",
      detail: `${stateDirectoryPath} is not present; generated keys go there on first run`,
    });
  }
  if (config.transport === "http") {
    try {
      validateHttpConfiguration();
      checks.push({ name: "http_auth", status: "pass", detail: "bearer token source and Host/Origin allowlists are valid" });
    } catch {
      checks.push({ name: "http_auth", status: "fail", detail: "configure one 32-byte token source; token files must be operator-owned regular files with mode 0600" });
    }
  }
  const output = { status: checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "pass", source_mode: config.source_mode, privacy_ceiling: config.privacy_ceiling, checks, ...(repairs.length > 0 ? { repairs } : {}) };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  else {
    for (const repair of repairs) process.stdout.write(`fix  ${repair.name}: ${repair.detail}\n`);
    process.stdout.write(`imessage-mcp doctor: ${output.status}\n`);
    for (const check of checks) process.stdout.write(`${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`);
  }
  return output.status === "fail" ? 1 : 0;
}
