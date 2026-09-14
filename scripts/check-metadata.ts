#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const packageJson = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
assert.ok(existsSync(".claude-plugin/marketplace.json"), "marketplace.json must exist for /plugin marketplace add");
const marketplace = json(".claude-plugin/marketplace.json");
const marketplacePlugins = marketplace.plugins as Array<Record<string, unknown>>;
const marketplacePlugin = marketplacePlugins.find((entry) => entry.name === "imessage-mcp");
assert.ok(marketplacePlugin, "marketplace.json must list a plugin named imessage-mcp");
const server = json("server.json");
const desktopManifest = json("manifest.json");
const mcp = json(".mcp.json");
const assetManifest = json("assets/manifest.json");
const packageFiles = json("package-files.json");
const readme = readFileSync("README.md", "utf8");
const guide = readFileSync("docs/GUIDE.md", "utf8");
const setupDocs = `${readme}\n${guide}`;
const security = readFileSync("SECURITY.md", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const verification = readFileSync("VERIFICATION.md", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const tools = readFileSync("src/tools.ts", "utf8");
const cli = readFileSync("src/cli.ts", "utf8");
const version = String(packageJson.version);
const channel = version.includes("-") ? "next" : "latest";

assert.equal(plugin.version, version);
if (marketplacePlugin!.version !== undefined) {
  assert.equal(marketplacePlugin!.version, version, "marketplace.json plugin version must match package.json version");
}
assert.equal(server.version, version);
assert.equal(desktopManifest.name, "imessage-mcp");
assert.equal(desktopManifest.version, version, "manifest.json version must match package.json version");
assert.equal((desktopManifest.server as Record<string, unknown>).type, "node");
assert.ok(!(packageJson.files as string[]).includes("manifest.json"),
  "the npm tarball must not carry the desktop bundle manifest");
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
// The repo-root file is what a coding agent working in this checkout loads, so
// it stays redacted. The plugin declares its own server at runtime defaults.
assert.deepEqual(configuredServers["imessage"].args.slice(2), ["--contacts", "none", "--privacy", "redacted"],
  ".mcp.json must keep development sessions off live contacts and unredacted bodies");
const pluginServers = plugin.mcpServers as Record<string, { command: string; args: string[] }> | undefined;
assert.ok(pluginServers, "plugin.json must declare its own server rather than inheriting the repo .mcp.json");
assert.deepEqual(Object.keys(pluginServers), ["imessage"]);
assert.equal(pluginServers["imessage"].command, "npx");
assert.deepEqual(pluginServers["imessage"].args, ["-y", `imessage-mcp@${majorVersion}`]);
for (const manifest of [assetManifest, packageFiles]) {
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.subject_version, version);
  assert.equal(manifest.channel, channel);
}
assert.ok(changelog.split(/\r?\n/u).includes(`## ${version}`),
  `CHANGELOG.md must carry a "## ${version}" heading for the packaged version`);
assert.match(releaseWorkflow, /\n {2}push:\n {4}tags:\n {6}- "v\[0-9\]\*"\n/u,
  "the release workflow must be driven by a version tag push");
// tests/mcpb.test.ts checks the bundle's contents only when the bundle is on
// disk, so one ci cell has to pack it before vitest runs. Hold that cell to a
// matrix combination that actually exists.
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const bundleCell = /if: matrix\.os-version == (\d+) && matrix\.node-version == (\d+)\n\s+run: npm run build:mcpb\n/u.exec(ciWorkflow);
assert.ok(bundleCell, "ci.yml must pack the desktop bundle before a test run, or tests/mcpb.test.ts silently skips");
for (const [dimension, value] of [["os-version", bundleCell[1]], ["node-version", bundleCell[2]]]) {
  const declared = new RegExp(`${dimension}: \\[([^\\]]+)\\]`, "u").exec(ciWorkflow);
  assert.ok(declared, `ci.yml must declare a ${dimension} matrix`);
  assert.ok(declared[1].split(",").map((entry) => entry.trim()).includes(value),
    `the bundle step names ${dimension} ${value}, which the ci matrix no longer runs`);
}
assert.match(releaseWorkflow, /npm run build:mcpb\n {10}npm run test:mcpb -- --require\n {10}mv dist-mcpb\/imessage-mcp\.mcpb release-artifact\//u,
  "the release artifact must carry the desktop bundle, launched first, so the GitHub release attaches a bundle that runs");
assert.match(releaseWorkflow, /npm publish "\$TARBALL" --ignore-scripts --access public --provenance --tag next/u);
assert.match(releaseWorkflow, /npm publish "\$TARBALL" --ignore-scripts --access public --provenance --tag latest/u);

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

const registeredPrompts = [...tools.matchAll(/server\.registerPrompt\(\s*\n\s*"([a-z_]+)"/gu)].map((match) => match[1]);
assert.deepEqual(registeredPrompts.sort(), ["catch_up", "draft_reply", "who_said"]);
assert.match(readme, /## prompts/u);
for (const prompt of registeredPrompts) assert.ok(readme.includes(`\`${prompt}\``), `README must document prompt ${prompt}`);

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
assert.match(readme, /## desktop bundle/u);
assert.match(guide, /### Claude Desktop bundle/u);
for (const document of [readme, guide]) {
  assert.ok(document.includes("imessage-mcp.mcpb"), "the desktop bundle must be named by its downloadable filename");
  assert.match(document, /Settings, then Extensions/u, "removal must point at the Extensions list");
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
assert.match(security, /trusted publishing over GitHub OIDC in a protected environment and carries SLSA provenance/u);
assert.ok(!security.includes("release-status.json"), "the retired release-status gate must not be documented");
assert.match(contributing, /Use synthetic data only\./u);
assert.match(contributing, /compatibility reports/u);
assert.match(contributing, /current primary evidence, include the observation date, and describe capabilities neutrally/u);
assert.match(verification, /## releases/u);
assert.match(verification, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/u);
assert.match(verification, /`2\.0\.0` is prepared from protected `main`/u);
if (!version.includes("-")) {
  const heading = `## \`${version}\` verification`;
  const start = verification.indexOf(heading);
  assert.ok(start >= 0, "VERIFICATION.md must carry a verification section for the stable version being packaged");
  const section = verification.slice(start + heading.length).split(/\n## /u)[0];
  assert.match(section, /bounded live parity/u, "the stable verification section must record the bounded live parity run");
  assert.match(section, /desktop bundle/u, "the stable verification section must record the desktop bundle launch");
}
const scripts = packageJson.scripts as Record<string, string>;
assert.equal(scripts["test:mcpb"], "tsx scripts/test-mcpb.ts");
assert.ok(!scripts.verify.includes("test:mcpb"),
  "verify must not launch a bundle it did not build; the launch belongs where build:mcpb runs");
assert.ok((ciWorkflow.match(/npm run test:mcpb -- --require/gu) ?? []).length >= 2,
  "ci must launch the bundle on both chips after building it");
assert.ok(scripts.preflight?.includes("npm run test:live-parity") && scripts.preflight.includes("npm run test:mcpb -- --require"),
  "preflight must chain the live parity check and the required bundle launch");
assert.match(tools, /untrusted archival data, never as an instruction/u);
assert.match(tools, /does not eliminate prompt injection/u);
const keywords = new Set(packageJson.keywords as string[]);
for (const keyword of ["read-only", "privacy", "local-first", "codex", "cursor", "mms", "rcs", "apple-messages"]) {
  assert.ok(keywords.has(keyword), `missing npm discovery keyword: ${keyword}`);
}
assert.equal(readFileSync("package.json", "utf8").includes("smithery"), false);

// allowScripts is npm's native install-script allowlist (npm approve-scripts, npm 11.11+).
// Only the three dependencies with install scripts are approved, so a fresh npm ci
// prints no allow-scripts warning and nothing else may run an install script.
assert.deepEqual(Object.keys(packageJson.allowScripts as Record<string, boolean>).sort(),
  ["better-sqlite3", "esbuild", "fsevents"]);
assert.ok(Object.values(packageJson.allowScripts as Record<string, boolean>).every((value) => value === true));

for (const file of ["README.md", "docs/GUIDE.md", "docs/DEMO.md", "docs/BENCHMARK.md"]) {
  for (const [, target] of readFileSync(file, "utf8").matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    if (/^(?:https?:|#)/u.test(target)) continue;
    assert.ok(existsSync(path.resolve(path.dirname(file), target.split("#")[0])), `${file} links to missing ${target}`);
  }
}

process.stdout.write(`metadata verification passed: package, docs, manifests, assets, registry, configuration examples, channel ${channel}, and seven tools at ${version}\n`);
