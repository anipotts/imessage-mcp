#!/usr/bin/env tsx

// Launches the packed Claude Desktop bundle the way the app does: unpack it,
// resolve the manifest's ${__dirname} and ${user_config.*} placeholders, start
// the entry point with node, and drive a real MCP session against a synthetic
// database. This is the check that the shipped artifact actually runs, on
// whichever chip runs this script, without anything resolving from npm.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createFixture } from "../tests/fixture.js";
import { cleanEnvironment } from "./launch-env.js";
import { PROMPT_ARGUMENTS, TOOL_NAMES } from "./test-protocol.js";

interface Manifest {
  name: string;
  version: string;
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } };
  compatibility: { platforms: string[] };
  user_config: Record<string, { default?: string }>;
}

const PROMPT_NAMES = Object.keys(PROMPT_ARGUMENTS).sort();

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = path.join(repository, "dist-mcpb", "imessage-mcp.mcpb");
const required = process.argv.includes("--require");

if (!existsSync(bundle)) {
  if (required) {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: "bundle missing; run npm run build:mcpb first" })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "no bundle on disk" })}\n`);
  process.exit(0);
}

function resolvePlaceholders(value: string, root: string, userConfig: Record<string, string>): string {
  const resolved = value
    .replaceAll("${__dirname}", root)
    .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/gu, (_match, key: string) => {
      assert.ok(key in userConfig, `manifest references user_config.${key} but declares no such setting`);
      return userConfig[key];
    });
  assert.doesNotMatch(resolved, /\$\{/u, `unresolved placeholder in launch argument: ${value}`);
  return resolved;
}

async function launch(
  root: string,
  manifest: Manifest,
  userConfig: Record<string, string>,
  databasePath: string,
  scratch: string,
): Promise<{ privacy: string; contacts: string; tools: number; prompts: number }> {
  assert.equal(manifest.server.mcp_config.command, "node", "the bundle must launch with the node runtime the app provides");
  const args = manifest.server.mcp_config.args.map((value) => resolvePlaceholders(value, root, userConfig));
  assert.equal(args[0], path.join(root, manifest.server.entry_point));
  const stateDirectory = path.join(scratch, `state-${userConfig.privacy}-${userConfig.contacts}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...args, "--database", databasePath],
    cwd: scratch,
    env: cleanEnvironment({ IMESSAGE_STATE_DIR: stateDirectory }),
    stderr: "pipe",
  });
  const client = new Client({ name: "desktop-bundle-launch", version: "1.0.0" });
  try {
    await client.connect(transport);
    const server = client.getServerVersion();
    assert.equal(server?.name, "imessage-mcp");
    assert.equal(server?.version, manifest.version, "the bundle must report the manifest version");

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
    for (const tool of tools.tools) {
      assert.ok(tool.title, `${tool.name} is missing a title`);
      assert.equal((tool.outputSchema as { type?: string } | undefined)?.type, "object", `${tool.name} is missing an output schema`);
    }
    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), PROMPT_NAMES);

    const status = await client.callTool({ name: "server_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const payload = status.structuredContent as { data?: { privacy_ceiling?: string; contacts?: { mode?: string } } };
    assert.equal(payload.data?.privacy_ceiling, userConfig.privacy, "user_config.privacy must become the runtime ceiling");

    // Opening a conversation list proves the bundled sqlite binary loaded for this chip.
    const conversations = await client.callTool({ name: "list_conversations", arguments: { limit: 5 } });
    assert.equal(conversations.isError, undefined);

    // Asking for more than the dialog allowed is refused outright, never quietly widened.
    const ceilingProbe = await client.callTool({ name: "server_status", arguments: { privacy_mode: "full" } });
    if (userConfig.privacy === "full") {
      assert.equal(ceilingProbe.isError, undefined);
    } else {
      assert.equal(ceilingProbe.isError, true, "a caller must not raise the ceiling above user_config.privacy");
      const refused = ceilingProbe.structuredContent as { error?: { reason?: string } };
      assert.equal(refused.error?.reason, "PRIVACY_RESTRICTED");
      assert.doesNotMatch(JSON.stringify(ceilingProbe), /"privacy_ceiling":"full"/u);
    }
    return { privacy: userConfig.privacy, contacts: userConfig.contacts, tools: tools.tools.length, prompts: prompts.prompts.length };
  } finally {
    await client.close();
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), "imessage-mcpb-launch-"));
const fixture = createFixture();
try {
  const root = path.join(scratch, "bundle");
  execFileSync("unzip", ["-q", bundle, "-d", root]);
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as Manifest;
  assert.deepEqual(manifest.compatibility.platforms, ["darwin"]);
  assert.equal(manifest.server.type, "node");
  assert.ok(existsSync(path.join(root, manifest.server.entry_point)), "entry point missing from bundle");
  assert.ok(!existsSync(path.join(root, "src")) && !existsSync(path.join(root, "tests")), "bundle must not carry sources or tests");
  const prebuilds = readdirSync(path.join(root, "node_modules", "better-sqlite3", "prebuilds")).sort();
  assert.deepEqual(prebuilds, ["darwin-arm64.node", "darwin-x64.node"]);
  const nativeBinary = path.join(root, "node_modules", "better-sqlite3", "prebuilds", `darwin-${arch()}.node`);
  assert.ok(lstatSync(nativeBinary).isFile(), `no prebuilt sqlite binary for darwin-${arch()}`);

  const defaults = Object.fromEntries(
    Object.entries(manifest.user_config).map(([key, setting]) => {
      assert.equal(typeof setting.default, "string", `user_config.${key} needs a default so the dialog can start with it`);
      return [key, setting.default as string];
    }),
  );
  // The dialog defaults to live Contacts, which the runtime only pairs with this
  // Mac's own Messages database. A synthetic database is a copy, so every launch
  // here uses handles; the dialog's privacy default still flows through untouched.
  assert.equal(defaults.contacts, "live");
  // Each launch owns its state directory, so the three ceilings run side by side.
  const launches = await Promise.all([
    { ...defaults, contacts: "none" },
    { ...defaults, privacy: "redacted", contacts: "none" },
    { ...defaults, privacy: "aggregate", contacts: "none" },
  ].map((userConfig) => launch(root, manifest, userConfig, fixture.databasePath, scratch)));

  // The guard itself must fail fast and name the reason rather than hang the app.
  const guarded = spawnSync(process.execPath, [
    ...manifest.server.mcp_config.args.map((value) => resolvePlaceholders(value, root, defaults)),
    "--database", fixture.databasePath,
  ], { cwd: scratch, env: cleanEnvironment({ IMESSAGE_STATE_DIR: path.join(scratch, "state-guard") }), input: "", encoding: "utf8", timeout: 60_000 });
  // The runtime rejects the pairing while parsing arguments, before it reads stdin.
  assert.equal(guarded.status, 1,
    `live Contacts with a copied database must exit 1 before reading stdin (status ${guarded.status}, signal ${guarded.signal})`);
  assert.match(guarded.stderr, /"reason":"INVALID_INPUT"/u);
  assert.doesNotMatch(guarded.stderr, /\/Users\/|chat\.db/u, "the refusal must not echo the database path");
  for (const state of readdirSync(scratch).filter((name) => name.startsWith("state-"))) {
    assert.equal(statSync(path.join(scratch, state)).mode & 0o777, 0o700, `${state} is not owner-only`);
  }
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    bundle: path.relative(repository, bundle),
    bytes: statSync(bundle).size,
    node: process.version,
    arch: arch(),
    launches,
  })}\n`);
} finally {
  fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true });
}
