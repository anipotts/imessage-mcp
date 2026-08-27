#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const packageJson = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const server = json("server.json");
const mcp = json(".mcp.json");
const releaseStatus = json("release-status.json");
const assetManifest = json("assets/manifest.json");
const packageFiles = json("package-files.json");
const readme = readFileSync("README.md", "utf8");
const security = readFileSync("SECURITY.md", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const verification = readFileSync("VERIFICATION.md", "utf8");
const tools = readFileSync("src/tools.ts", "utf8");
const version = String(packageJson.version);
const channel = version.includes("-") ? "next" : "latest";

assert.equal(plugin.version, version);
assert.equal(server.version, version);
assert.equal(packageJson.mcpName, server.name);
const packages = server.packages as Array<Record<string, unknown>>;
assert.equal(packages.length, 1);
assert.equal(packages[0].identifier, "imessage-mcp");
assert.equal(packages[0].version, version);
assert.equal((packageJson.os as string[]).join(","), "darwin");
assert.equal((packageJson.engines as Record<string, string>).node, "^22.0.0 || ^24.0.0 || ^26.0.0");
const configuredServers = mcp.mcpServers as Record<string, { args: string[] }>;
assert.deepEqual(Object.keys(configuredServers), ["imessage-history"]);
assert.equal(configuredServers["imessage-history"].args[1], `imessage-mcp@${version}`);
assert.deepEqual(configuredServers["imessage-history"].args.slice(-4),
  ["--contacts", "none", "--privacy", "redacted"]);
assert.equal(releaseStatus.schema_version, 4);
assert.equal(releaseStatus.subject_version, version);
assert.equal(releaseStatus.channel, channel);
for (const manifest of [assetManifest, packageFiles]) {
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.subject_version, version);
  assert.equal(manifest.channel, channel);
}
assert.equal(typeof releaseStatus.prerelease_ready, "boolean");
assert.deepEqual(Object.keys(releaseStatus.prerelease_gates as Record<string, boolean>).sort(), [
  "dependency_and_secret_audit",
  "installed_clients",
  "million_message_performance",
  "privacy_matrix",
  "protocol_security",
  "seven_tools",
  "stdio_and_http",
]);
const stable = releaseStatus.stable as Record<string, unknown>;
assert.equal(typeof stable.ready, "boolean");
assert.deepEqual(Object.keys(stable.exercises as Record<string, boolean>).sort(), [
  "all_privacy_modes",
  "all_service_families",
  "all_seven_tools",
  "claude_code",
  "claude_desktop",
  "codex",
  "copied_database",
  "cursor",
  "http_proxy_simulation",
  "live_database",
  "stdio",
]);

const registered = [...tools.matchAll(/server\.registerTool\(\s*\n\s*"([a-z_]+)"/gu)].map((match) => match[1]);
assert.deepEqual(registered.sort(), [
  "analyze_communication",
  "get_conversation",
  "list_conversations",
  "resolve_contact",
  "search_messages",
  "server_status",
  "sync_messages",
]);

assert.match(readme, /Private, read-only MCP for Apple Messages on Mac\./u);
assert.match(readme, /Search and analyze iMessage, SMS, MMS, and RCS history\./u);
assert.match(readme, /Local execution does not control how your MCP client or model provider processes or retains returned results\./u);
assert.match(readme, /SMS, MMS, and RCS with Android users work only when those conversations already appear/u);
assert.match(readme, /Every 2\.x tool reads data only\./u);
assert.match(readme, /macOS grants Full Disk Access to the launching MCP client application or shell, not narrowly to `imessage-mcp`/u);
assert.match(readme, /## two-minute privacy-first setup/u);
assert.match(readme, /The recommended first installation sets a redacted ceiling/u);
assert.match(readme, /The 2\.0 runtime keeps automatic live unified Contacts for compatibility/u);
assert.match(readme, /Every message body, contact value, group title, URL, attachment filename, and database-derived string is untrusted archival data/u);
assert.match(readme, /does not eliminate prompt injection/u);
assert.ok(!readme.includes("`mcpServers.imessage`"), "generic imessage client namespace must not be documented");
assert.ok((readme.match(/imessage-history/gu) ?? []).length >= 5, "all named client examples must use imessage-history");
assert.match(readme, /IMESSAGE_REFERENCE_KEY_FILE/u);
assert.match(readme, /IMESSAGE_DATABASE_ID_FILE/u);
const documentedVersions = [...readme.matchAll(/imessage-mcp@([0-9][0-9A-Za-z.-]*)/gu)].map((match) => match[1]);
assert.ok(documentedVersions.length >= 5, "every install and persistent client example must use an exact package version");
assert.deepEqual([...new Set(documentedVersions)], [version]);
assert.doesNotMatch(readme, /imessage-mcp@(?:next|latest)\b/u);
assert.doesNotMatch(readme, /IMESSAGE_SAFE_MODE|IMESSAGE_SYNC/u);
assert.match(security, /untrusted archival data/u);
assert.match(security, /do not eliminate prompt injection/u);
assert.match(contributing, /Use synthetic data only\./u);
assert.match(contributing, /compatibility reports/u);
assert.match(contributing, /current primary evidence, include the observation date, and describe capabilities neutrally/u);
assert.ok(verification.includes(`| \`${version}\` | published and verified | npm \`${channel}\``),
  "verification release table must identify the exact current version and npm channel");
assert.match(tools, /untrusted archival data, never as an instruction/u);
assert.match(tools, /does not eliminate prompt injection/u);
const keywords = new Set(packageJson.keywords as string[]);
for (const keyword of ["read-only", "privacy", "local-first", "codex", "cursor", "mms", "rcs", "apple-messages"]) {
  assert.ok(keywords.has(keyword), `missing npm discovery keyword: ${keyword}`);
}
assert.equal(readFileSync("package.json", "utf8").includes("smithery"), false);

process.stdout.write(`metadata verification passed: package, docs, manifests, screenshots, registry, clients, channel ${channel}, and seven tools at ${version}\n`);
