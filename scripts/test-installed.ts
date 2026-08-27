#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    execFileSync(binary, ["doctor", "--database", fixture.databasePath, "--contacts", "none", "--json"], {
      cwd: install,
      env: {
        ...process.env,
        IMESSAGE_REFERENCE_KEY: "synthetic-reference-key-".padEnd(48, "x"),
        IMESSAGE_DATABASE_ID: "synthetic-database-lineage-".padEnd(48, "x"),
      },
      stdio: "ignore",
    });
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
      `${(installedBytes / (1024 * 1024)).toFixed(1)} MiB, package contents, help, doctor, stdio, and isolated clients\n`,
    );
  } finally {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
