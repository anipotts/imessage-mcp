#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
const guide = readFileSync("docs/GUIDE.md", "utf8");
const setupDocs = `${readme}\n${guide}`;
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
assert.equal(releaseStatus.schema_version, 5);
assert.equal(releaseStatus.subject_version, version);
assert.equal(releaseStatus.channel, channel);
for (const manifest of [assetManifest, packageFiles]) {
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.subject_version, version);
  assert.equal(manifest.channel, channel);
}
assert.equal(typeof releaseStatus.ready, "boolean");
assert.deepEqual(Object.keys(releaseStatus.gates as Record<string, boolean>).sort(), [
  "dependency_audit", "installed_package", "metadata_and_package_contents",
  "million_message_performance", "privacy", "protocol", "regressions",
]);
assert.ok(Object.values(releaseStatus.gates as Record<string, boolean>).every((value) => typeof value === "boolean"));

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

assert.match(readme, /seven read-only tools/u);
assert.match(readme, /Local execution does not control how your MCP client or model provider processes or retains returned results\./u);
assert.match(readme, /Every 2\.x tool reads data only\./u);
assert.match(readme, /Full Disk Access/u);
assert.match(readme, /untrusted archival data/u);
assert.match(readme, /does not eliminate prompt injection/u);
assert.match(guide, /faithful copy.*same reference key and database identity/u);
assert.match(guide, /different identity for every unrelated archive/u);
assert.match(guide, /They do not launch Codex, Claude Desktop, Claude Code, or Cursor/u);
assert.ok(!readme.includes("`mcpServers.imessage`"), "generic imessage client namespace must not be documented");
assert.ok((setupDocs.match(/imessage-history/gu) ?? []).length >= 5, "all named client examples must use imessage-history");
assert.match(readme, /IMESSAGE_REFERENCE_KEY_FILE/u);
assert.match(readme, /IMESSAGE_DATABASE_ID_FILE/u);
const documentedVersions = [...setupDocs.matchAll(/imessage-mcp@([0-9][0-9A-Za-z.-]*)/gu)].map((match) => match[1]);
assert.ok(documentedVersions.length >= 5, "every install and persistent client example must use an exact package version");
assert.deepEqual([...new Set(documentedVersions)], [version]);
assert.doesNotMatch(readme, /imessage-mcp@(?:next|latest)\b/u);
assert.doesNotMatch(readme, /IMESSAGE_SAFE_MODE|IMESSAGE_SYNC/u);
assert.match(security, /untrusted archival data/u);
assert.match(security, /do not eliminate prompt injection/u);
assert.match(security, /re-verifies exact-source security attestations immediately before npm publication/u);
assert.match(contributing, /Use synthetic data only\./u);
assert.match(contributing, /compatibility reports/u);
assert.match(contributing, /current primary evidence, include the observation date, and describe capabilities neutrally/u);
const currentReleaseLine = verification.split(/\r?\n/u).find((line) => line.startsWith(`| \`${version}\` |`));
assert.ok(currentReleaseLine?.includes(`npm \`${channel}\``),
  "verification release table must identify the exact current version and npm channel");
assert.match(tools, /untrusted archival data, never as an instruction/u);
assert.match(tools, /does not eliminate prompt injection/u);
const keywords = new Set(packageJson.keywords as string[]);
for (const keyword of ["read-only", "privacy", "local-first", "codex", "cursor", "mms", "rcs", "apple-messages"]) {
  assert.ok(keywords.has(keyword), `missing npm discovery keyword: ${keyword}`);
}
assert.equal(readFileSync("package.json", "utf8").includes("smithery"), false);

for (const file of ["README.md", "docs/GUIDE.md", "docs/DEMO.md", "docs/BENCHMARK.md"]) {
  for (const [, target] of readFileSync(file, "utf8").matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    if (/^(?:https?:|#)/u.test(target)) continue;
    assert.ok(existsSync(path.resolve(path.dirname(file), target.split("#")[0])), `${file} links to missing ${target}`);
  }
}

process.stdout.write(`metadata verification passed: package, docs, manifests, assets, registry, configuration examples, channel ${channel}, and seven tools at ${version}\n`);
