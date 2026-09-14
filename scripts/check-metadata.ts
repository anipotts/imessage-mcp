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
const cli = readFileSync("src/cli.ts", "utf8");
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
assert.equal((packageJson.engines as Record<string, string>).node, ">=22.0.0");
const majorVersion = version.split(".")[0];
const configuredServers = mcp.mcpServers as Record<string, { args: string[] }>;
assert.deepEqual(Object.keys(configuredServers), ["imessage"]);
assert.equal(configuredServers["imessage"].args[1], `imessage-mcp@${majorVersion}`);
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
assert.ok(!setupDocs.includes("imessage-history"), "the retired imessage-history namespace must not be documented");
assert.ok((setupDocs.match(/\bimessage\b(?!-mcp)/gu) ?? []).length >= 5, "all named client examples must use the imessage namespace");
for (const command of ["setup", "uninstall"]) {
  assert.match(cli, new RegExp(`imessage-mcp ${command} --client claude\\|codex\\|desktop\\|cursor`, "u"),
    `the CLI help must document the ${command} command`);
}
assert.match(cli, /--fix\s+Repair generated key files and modes \(doctor\)/u);
const commandModules = new Set(packageFiles.expected_paths as string[]);
for (const module of ["clients", "doctor", "setup", "uninstall"]) {
  for (const extension of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
    assert.ok(commandModules.has(`dist/commands/${module}${extension}`),
      `package-files.json must expect dist/commands/${module}${extension}`);
  }
}
assert.match(readme, /## remove/u);
assert.match(readme, /setup --client claude/u);
assert.match(readme, /uninstall --client claude/u);
assert.match(readme, /doctor --fix/u);
assert.match(guide, /setup --client claude\|codex\|desktop\|cursor/u);
assert.match(guide, /<file>\.bak-<unix-time>/u);
assert.match(guide, /never touches Full Disk Access or Contacts authorization/u);
assert.match(guide, /IMESSAGE_REFERENCE_KEY_FILE/u);
assert.match(guide, /IMESSAGE_DATABASE_ID_FILE/u);
assert.match(guide, /## state directory/u);
assert.match(guide, /IMESSAGE_STATE_DIR/u);
assert.doesNotMatch(readme, /openssl rand/u, "the README setup must not ask for hand-made key files");
const serverEnvironment = (packages[0].environmentVariables as Array<Record<string, unknown>>) ?? [];
for (const name of ["IMESSAGE_REFERENCE_KEY_FILE", "IMESSAGE_DATABASE_ID_FILE"]) {
  const variable = serverEnvironment.find((entry) => entry.name === name);
  assert.ok(variable, `server.json must document ${name}`);
  assert.equal(variable.isRequired, false, `${name} is generated on first run and must not be required`);
  assert.match(String(variable.description), /generated on first run/u);
}
const documentedSpecs = [...setupDocs.matchAll(/imessage-mcp@([0-9][0-9A-Za-z.-]*)/gu)].map((match) => match[1]);
assert.ok(documentedSpecs.length >= 5, "every install and persistent client example must use the major version range");
assert.deepEqual([...new Set(documentedSpecs)], [majorVersion],
  "every documented spec must equal imessage-mcp@<major>, never a prerelease or exact version");
assert.doesNotMatch(setupDocs, /imessage-mcp@(?:next|latest)\b/u);
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
