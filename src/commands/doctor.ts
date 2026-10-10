import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeConfig } from "../config.js";
import { UnifiedContactResolver } from "../contacts.js";
import { DatabaseContext } from "../database.js";
import { ImessageMcpError } from "../errors.js";
import { conversationMembershipSummary } from "../repositories/conversation-topology.js";
import { findResponsibleApp, fullDiskAccessInstruction } from "../responsible-app.js";
import { estimateSearchIndexFloor, searchIndexMemoryLimit } from "../search-index.js";
import { sqliteCheckpointAvailable } from "../sqlite.js";
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

// Keep diagnostic failure codes useful without forwarding database contents,
// local paths, SQLite messages, or other uncontrolled exception text.
const DIAGNOSTIC_REASONS = new Set([
  "DATABASE_UNAVAILABLE", "DATABASE_CHANGED", "UNSUPPORTED_SCHEMA",
  "QUERY_BUDGET_EXCEEDED", "INDEX_TOO_LARGE",
]);

function failureDetail(detail: string, error: unknown): string {
  return error instanceof ImessageMcpError && DIAGNOSTIC_REASONS.has(error.reason)
    ? `${detail} (${error.reason})`
    : detail;
}

function failureStatus(error: unknown): "warn" | "fail" {
  // These fixed reasons describe errors that prevent the corresponding tools
  // from running. A summary failure without a known reason stays informational.
  return error instanceof ImessageMcpError && DIAGNOSTIC_REASONS.has(error.reason) ? "fail" : "warn";
}

function conversationMembership(database: DatabaseContext): DoctorCheck {
  const request = database.request();
  try {
    const summary = conversationMembershipSummary(request);
    const unusual = summary.shared_messages > 0 || summary.unlinked_messages > 0;
    const counts = `${summary.total_messages} total messages; ${summary.joined_messages} linked; ` +
      `${summary.shared_messages} shared across conversations; ${summary.unlinked_messages} unlinked`;
    return {
      name: "conversation_membership",
      status: unusual ? "warn" : "pass",
      detail: unusual
        ? `${counts}; shared memberships are supported, and conversation tools use only recorded memberships`
        : counts,
    };
  } finally {
    request.close();
  }
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

function indexCache(config: RuntimeConfig): DoctorCheck {
  if (process.env.IMESSAGE_CACHE === "0") {
    return {
      name: "index_cache", status: "pass",
      detail: "encrypted index cache is off (IMESSAGE_CACHE=0); search works in memory and rebuilds after restart",
    };
  }
  if (config.source_mode === "copy") {
    return {
      name: "index_cache", status: "pass",
      detail: "copied databases keep the search index in memory; search rebuilds after restart",
    };
  }
  if (!sqliteCheckpointAvailable()) {
    return {
      name: "index_cache", status: "warn",
      detail: "this Node runtime lacks SQLite checkpoint support; search works in memory and rebuilds after restart",
    };
  }
  const cacheDirectory = path.join(homedir(), "Library/Caches/imessage-mcp");
  return {
    name: "index_cache", status: "pass",
    detail: existsSync(cacheDirectory)
      ? `encrypted index cache in ${cacheDirectory}; deleting it only costs one rebuild`
      : "no index cache yet; the first search builds it",
  };
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
        checks.push(conversationMembership(database));
      } catch (error) {
        checks.push({ name: "conversation_membership", status: failureStatus(error), detail: failureDetail("conversation memberships could not be summarized from this archive", error) });
      }
      try {
        checks.push(searchIndexCapacity(database, options.searchIndexMemoryLimitBytes ?? searchIndexMemoryLimit()));
      } catch (error) {
        checks.push({ name: "search_index_capacity", status: failureStatus(error), detail: failureDetail("the search index size could not be estimated from this archive", error) });
      }
    } finally {
      database.close();
    }
  } catch (error) {
    checks.push({ name: "schema", status: "fail", detail: failureDetail("the Messages database could not be opened or its schema inspected read-only", error) });
    checks.push({ name: "conversation_membership", status: failureStatus(error), detail: failureDetail("conversation memberships could not be summarized from this archive", error) });
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

  checks.push(indexCache(config));

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
