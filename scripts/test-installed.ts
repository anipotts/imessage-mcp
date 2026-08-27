#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(paths.includes("npm-shrinkwrap.json"));

    const packageVersionValue = packageVersion("package.json");
    assert.equal(packageVersion(".claude-plugin/plugin.json"), packageVersionValue);
    assert.equal(packageVersion("server.json"), packageVersionValue);
    const server = JSON.parse(readFileSync("server.json", "utf8")) as { packages: Array<{ version: string }> };
    assert.equal(server.packages[0].version, packageVersionValue);

    const install = path.join(scratch, "install");
    mkdirSync(install);
    writeFileSync(path.join(install, "package.json"), JSON.stringify({ private: true }));
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", path.join(scratch, packed[0].filename)], {
      cwd: install,
      stdio: "ignore",
    });
    execFileSync(process.execPath, [
      path.join(install, "node_modules", "imessage-mcp", "dist", "verify-installed-graph.js"),
      install,
      path.join(process.cwd(), "npm-shrinkwrap.json"),
    ], { cwd: install });
    const binary = path.join(install, "node_modules", ".bin", "imessage-mcp");
    assert.equal(execFileSync(binary, ["--version"], { cwd: install, encoding: "utf8" }).trim(), packageVersionValue);
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
        imessage: {
          command: binary,
          args: ["--database", fixture.databasePath, "--contacts", "none"],
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
      assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.imessage.command, binary);
    }
    process.stdout.write("installed tarball verification passed: package contents, doctor, stdio, and isolated client configs\n");
  } finally {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
