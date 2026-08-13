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
const readme = readFileSync("README.md", "utf8");
const tools = readFileSync("src/tools.ts", "utf8");
const version = String(packageJson.version);

assert.equal(plugin.version, version);
assert.equal(server.version, version);
assert.equal(packageJson.mcpName, server.name);
const packages = server.packages as Array<Record<string, unknown>>;
assert.equal(packages.length, 1);
assert.equal(packages[0].identifier, "imessage-mcp");
assert.equal(packages[0].version, version);
assert.equal((packageJson.os as string[]).join(","), "darwin");
assert.equal((packageJson.engines as Record<string, string>).node, "^22.0.0 || ^24.0.0 || ^26.0.0");
assert.equal((mcp.mcpServers as Record<string, { args: string[] }>).imessage.args.at(-1), `imessage-mcp@${version}`);
assert.equal(releaseStatus.schema_version, 4);
assert.equal(releaseStatus.subject_version, version);
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

assert.match(readme, /read-only MCP for iMessage, SMS, MMS, and RCS history in Apple Messages on Mac\./u);
assert.match(readme, /Android-originated SMS, MMS, and RCS are available only when those conversations already appear/u);
assert.match(readme, /Every 2\.x release is strictly read-only/u);
assert.match(readme, /IMESSAGE_REFERENCE_KEY_FILE/u);
const documentedVersions = [...readme.matchAll(/imessage-mcp@([0-9][0-9A-Za-z.-]*)/gu)].map((match) => match[1]);
assert.ok(documentedVersions.length >= 5, "every install and persistent client example must use an exact package version");
assert.deepEqual([...new Set(documentedVersions)], [version]);
assert.doesNotMatch(readme, /imessage-mcp@(?:next|latest)\b/u);
assert.doesNotMatch(readme, /IMESSAGE_SAFE_MODE|IMESSAGE_SYNC/u);
assert.equal(readFileSync("package.json", "utf8").includes("smithery"), false);

process.stdout.write(`metadata verification passed: package, plugin, registry, clients, readme, and seven tools at ${version}\n`);
