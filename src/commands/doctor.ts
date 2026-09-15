import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeConfig } from "../config.js";
import { UnifiedContactResolver } from "../contacts.js";
import { DatabaseContext } from "../database.js";
import { findResponsibleApp, fullDiskAccessInstruction } from "../responsible-app.js";
import { estimateSearchIndexFloor, searchIndexMemoryLimit } from "../search-index.js";
import { validateHttpConfiguration } from "../transport.js";
import { checkForUpdate } from "../update-check.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

const MIB = 1024 * 1024;
const packageVersion = readFileSync(new URL("../../package.json", import.meta.url), "utf8");

function formatBytes(value: number): string {
  return value >= MIB ? `${(value / MIB).toFixed(1)} MiB` : `${value} bytes`;
}

function searchIndexCapacity(database: DatabaseContext, limitBytes: number): DoctorCheck {
  const request = database.request();
  try {
    const estimate = estimateSearchIndexFloor(request);
    const status = estimate.estimated_bytes > limitBytes ? "fail" : estimate.estimated_bytes >= limitBytes * 0.9 ? "warn" : "pass";
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
  // Test seam for the capacity check on a small synthetic archive.
  options: { searchIndexMemoryLimitBytes?: number } = {},
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const version = (JSON.parse(packageVersion) as { version: string }).version;
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 24 || (major === 24 && minor >= 16);
  checks.push({ name: "node", status: nodeOk ? "pass" : "fail", detail: nodeOk ? `Node ${process.versions.node}` : `Node ${process.versions.node}; imessage-mcp needs 24.16 or newer` });

  try {
    accessSync(config.database_path, constants.R_OK);
    checks.push({ name: "database_read", status: "pass", detail: "Messages database is readable" });
  } catch (error) {
    const missing = (error as { code?: unknown }).code === "ENOENT";
    checks.push({
      name: "database_read",
      status: "fail",
      detail: missing
        ? "Messages database was not found; open Messages on this Mac once so it creates its history"
        : fullDiskAccessInstruction(findResponsibleApp()),
    });
  }

  try {
    const database = new DatabaseContext(config.database_path, config.source_mode);
    try {
      const supported = database.capabilities.required_core === "available";
      checks.push({ name: "schema", status: supported ? "pass" : "fail", detail: supported ? `supported Messages schema ${database.capabilities.schema_fingerprint.slice(0, 12)}` : "this Messages schema is not supported" });
      try {
        checks.push(searchIndexCapacity(database, options.searchIndexMemoryLimitBytes ?? searchIndexMemoryLimit()));
      } catch {
        checks.push({ name: "search_index_capacity", status: "warn", detail: "the search index size could not be estimated from this archive" });
      }
    } finally {
      database.close();
    }
  } catch {
    checks.push({ name: "schema", status: "fail", detail: "the Messages database could not be opened read-only" });
  }

  if (config.contacts_mode === "none") {
    checks.push({ name: "contacts", status: "pass", detail: "names are off (--contacts none); results show handles" });
  } else {
    const contacts = new UnifiedContactResolver(true).status();
    checks.push({
      name: "contacts",
      status: contacts.state === "available" ? "pass" : "warn",
      detail: contacts.state === "available"
        ? `${contacts.count} contacts read from Contacts' own database under Full Disk Access`
        : `continuing with handles only (${contacts.reason})`,
    });
  }

  const cacheDirectory = path.join(homedir(), "Library/Caches/imessage-mcp");
  checks.push({
    name: "index_cache",
    status: "pass",
    detail: existsSync(cacheDirectory)
      ? `encrypted index cache in ${cacheDirectory}; deleting it only costs one rebuild`
      : "no index cache yet; the first search builds it",
  });

  const legacyState = path.join(homedir(), "Library/Application Support/imessage-mcp");
  if (existsSync(legacyState)) {
    checks.push({ name: "legacy_state", status: "warn", detail: `${legacyState} holds 2.x reference keys that 3.x no longer uses; it is safe to delete` });
  }

  const update = await checkForUpdate(version);
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

  if (config.transport === "http") {
    try {
      validateHttpConfiguration();
      checks.push({ name: "http_auth", status: "pass", detail: "bearer token and Host/Origin allowlists are valid" });
    } catch {
      checks.push({ name: "http_auth", status: "fail", detail: "set IMESSAGE_API_TOKEN, or IMESSAGE_API_TOKEN_FILE pointing at an owner-only 0600 file" });
    }
  }

  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "pass";
  if (json) {
    process.stdout.write(`${JSON.stringify({ status, source_mode: config.source_mode, privacy_ceiling: config.privacy_ceiling, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`imessage-mcp doctor: ${status}\n`);
    for (const check of checks) process.stdout.write(`${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`);
  }
  return status === "fail" ? 1 : 0;
}
