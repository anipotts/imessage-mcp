#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixture } from "../tests/fixture.js";
import { runStdio } from "./test-protocol.js";
import { assertPackedPackage } from "./package-manifest.js";

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

function packageVersion(file: string): string {
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

function directoryBytes(root: string): number {
  let total = 0;
  const queue = [root];
  while (queue.length) {
    const current = queue.pop() as string;
    for (const name of readdirSync(current)) {
      const selected = path.join(current, name);
      const stat = lstatSync(selected);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) queue.push(selected);
      else if (stat.isFile()) total += stat.size;
    }
  }
  return total;
}

function dependencyNodes(value: { dependencies?: Record<string, unknown> }): number {
  return Object.values(value.dependencies ?? {}).reduce(
    (total, dependency) => total + 1 + dependencyNodes(dependency as { dependencies?: Record<string, unknown> }),
    0,
  );
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    "IMESSAGE_REFERENCE_KEY",
    "IMESSAGE_REFERENCE_KEY_FILE",
    "IMESSAGE_DATABASE_ID",
    "IMESSAGE_DATABASE_ID_FILE",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !blocked.has(entry[0]),
      ),
    ),
    ...extra,
  };
}

async function runCleanRoomFirstRequest(binary: string, fixture: ReturnType<typeof createFixture>, scratch: string): Promise<void> {
  const referenceKeyFile = path.join(scratch, "reference-key");
  const databaseIdFile = path.join(scratch, "database-id");
  writeFileSync(referenceKeyFile, "synthetic-reference-key-".padEnd(48, "x"), { mode: 0o600 });
  writeFileSync(databaseIdFile, "synthetic-database-lineage-".padEnd(48, "x"), { mode: 0o600 });
  assert.equal(lstatSync(referenceKeyFile).mode & 0o777, 0o600);
  assert.equal(lstatSync(databaseIdFile).mode & 0o777, 0o600);

  const transport = new StdioClientTransport({
    command: binary,
    args: ["--database", fixture.databasePath, "--contacts", "none", "--privacy", "redacted"],
    cwd: scratch,
    env: cleanEnvironment({
      IMESSAGE_REFERENCE_KEY_FILE: referenceKeyFile,
      IMESSAGE_DATABASE_ID_FILE: databaseIdFile,
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "clean-room-first-run", version: "1.0.0" });
  try {
    await client.connect(transport);
    const status = await client.callTool({
      name: "server_status",
      arguments: { privacy_mode: "redacted" },
    });
    assert.equal(status.isError, undefined);
    const conversations = await client.callTool({
      name: "list_conversations",
      arguments: { limit: 10, privacy_mode: "redacted" },
    });
    assert.equal(conversations.isError, undefined);
    const output = JSON.stringify([status, conversations]);
    assert.doesNotMatch(output, /blob exact|thread reply|photo\.png|\+1555000000|unknown@example/u);
    assert.doesNotMatch(output, /T\d{2}:\d{2}:\d{2}/u);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "imessage-mcp-installed-"));
  const fixture = createFixture();
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: process.cwd(),
      encoding: "utf8",
    })) as PackResult[];
    assert.equal(packed.length, 1);
    const paths = packed[0].files.map((file) => file.path).sort();
    assertPackedPackage(paths);
    assert.ok(paths.includes("dist/tool-worker.js"));
    assert.ok(paths.includes(".claude-plugin/plugin.json"));
    assert.ok(paths.includes(".mcp.json"));
    assert.ok(paths.includes("native/message-text-decoder.js"));
    assert.ok(paths.includes("release-status.json"));
    assert.ok(paths.includes("VERIFICATION.md"));
    assert.ok(paths.includes("server.json"));
    assert.ok(!paths.includes("npm-shrinkwrap.json"));
    assert.ok(!paths.includes("package-lock.json"));

    const packageVersionValue = packageVersion("package.json");
    assert.equal(packageVersion(".claude-plugin/plugin.json"), packageVersionValue);
    assert.equal(packageVersion("server.json"), packageVersionValue);
    const server = JSON.parse(readFileSync("server.json", "utf8")) as { packages: Array<{ version: string }> };
    assert.equal(server.packages[0].version, packageVersionValue);

    const install = path.join(scratch, "install");
    mkdirSync(install);
    writeFileSync(path.join(install, "package.json"), JSON.stringify({ private: true }));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", path.join(scratch, packed[0].filename)], {
      cwd: install,
      stdio: "ignore",
    });
    execFileSync(process.execPath, [
      path.join(install, "node_modules", "imessage-mcp", "dist", "verify-installed-graph.js"),
      install,
      path.join(process.cwd(), "package-lock.json"),
    ], { cwd: install });
    const installedTree = JSON.parse(execFileSync("npm", ["ls", "--all", "--json"], {
      cwd: install,
      encoding: "utf8",
    })) as { problems?: string[]; dependencies?: Record<string, unknown> };
    assert.deepEqual(installedTree.problems ?? [], [], "vanilla install must not contain extraneous or invalid packages");
    const installedBytes = directoryBytes(path.join(install, "node_modules"));
    const installedNodes = dependencyNodes(installedTree);
    assert.ok(installedNodes <= 12, "vanilla installed dependency graph must remain bounded");
    assert.ok(installedBytes < 128 * 1024 * 1024,
      "vanilla installed dependency graph must remain below 128 MiB");
    const installedRoot = path.join(install, "node_modules", "imessage-mcp");
    const installedReadme = readFileSync(path.join(installedRoot, "README.md"), "utf8");
    const installedSecurity = readFileSync(path.join(installedRoot, "SECURITY.md"), "utf8");
    const installedTools = readFileSync(path.join(installedRoot, "dist", "tools.js"), "utf8");
    for (const value of [installedReadme, installedSecurity, installedTools]) {
      assert.match(value, /untrusted archival data/u);
      assert.match(value, /do(?:es)? not eliminate prompt injection/u);
    }
    assert.match(installedReadme, /model provider processes or retains returned results/u);
    const installedMcp = JSON.parse(readFileSync(path.join(installedRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    assert.deepEqual(Object.keys(installedMcp.mcpServers), ["imessage-history"]);
    assert.deepEqual(installedMcp.mcpServers["imessage-history"].args.slice(-4),
      ["--contacts", "none", "--privacy", "redacted"]);
    const binary = path.join(install, "node_modules", ".bin", "imessage-mcp");
    assert.equal(execFileSync(binary, ["--version"], { cwd: install, encoding: "utf8" }).trim(), packageVersionValue);
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const help = execFileSync(binary, args, { cwd: install, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
      assert.match(help, /First run \(privacy-first\):/u);
      assert.match(help, /--contacts <mode>/u);
      assert.match(help, /--privacy <mode>/u);
      assert.match(help, /Full Disk Access belongs to the launching MCP client/u);
    }
    const doctorHelp = execFileSync(binary, ["doctor", "--help"], {
      cwd: install,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.match(doctorHelp, /Read-only diagnostics/u);
    assert.match(doctorHelp, /never opens settings or changes permissions/u);
    const firstRunReferenceKey = path.join(scratch, "doctor-reference-key");
    const firstRunDatabaseId = path.join(scratch, "doctor-database-id");
    writeFileSync(firstRunReferenceKey, "synthetic-reference-key-".padEnd(48, "x"), { mode: 0o600 });
    writeFileSync(firstRunDatabaseId, "synthetic-database-lineage-".padEnd(48, "x"), { mode: 0o600 });
    const doctorOutput = execFileSync(binary, ["doctor", "--database", fixture.databasePath, "--contacts", "none", "--privacy", "redacted", "--json"], {
      cwd: install,
      env: cleanEnvironment({
        IMESSAGE_REFERENCE_KEY_FILE: firstRunReferenceKey,
        IMESSAGE_DATABASE_ID_FILE: firstRunDatabaseId,
      }),
      encoding: "utf8",
    });
    const doctorResult = JSON.parse(doctorOutput) as {
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    assert.deepEqual(doctorResult.checks.find((check) => check.name === "contacts"), {
      name: "contacts",
      status: "pass",
      detail: "disabled by --contacts none; using handles only",
    });
    await runCleanRoomFirstRequest(binary, fixture, scratch);
    await runStdio(binary, [], fixture);

    const clientConfig = {
      mcpServers: {
        "imessage-history": {
          command: binary,
          args: ["--database", fixture.databasePath, "--contacts", "none", "--privacy", "redacted"],
          env: {
            IMESSAGE_REFERENCE_KEY_FILE: "/operator-owned/path/to/imessage-reference-key",
            IMESSAGE_DATABASE_ID_FILE: "/operator-owned/path/to/imessage-database-id",
          },
        },
      },
    };
    for (const client of ["codex", "claude-desktop", "claude-code", "cursor"]) {
      const file = path.join(scratch, `${client}.json`);
      writeFileSync(file, JSON.stringify(clientConfig));
      const configured = JSON.parse(readFileSync(file, "utf8")) as typeof clientConfig;
      assert.equal(configured.mcpServers["imessage-history"].command, binary);
      assert.deepEqual(configured.mcpServers["imessage-history"].args.slice(-4),
        ["--contacts", "none", "--privacy", "redacted"]);
    }
    process.stdout.write(
      `installed tarball verification passed: ${installedNodes} dependency nodes, ` +
      `${(installedBytes / (1024 * 1024)).toFixed(1)} MiB, package contents, help, doctor, ` +
      `clean-room redacted first run, stdio, and isolated clients\n`,
    );
  } finally {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
