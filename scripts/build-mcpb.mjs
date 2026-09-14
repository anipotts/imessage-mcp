#!/usr/bin/env node

// Packs the Claude Desktop bundle. The staged tree carries only what the server
// needs at runtime, so the bundle never ships tests, sources, or dev dependencies.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(repository, "dist-mcpb");
const stage = path.join(output, "stage");
const bundle = path.join(output, "imessage-mcp.mcpb");

if (path.dirname(output) !== repository || path.basename(output) !== "dist-mcpb") {
  throw new Error("refusing to write an unexpected bundle directory");
}

const run = (command, args, cwd) => {
  execFileSync(command, args, { cwd, stdio: "inherit" });
};

rmSync(output, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of ["dist", "bin", "native", "package.json", "package-lock.json", "manifest.json"]) {
  const source = path.join(repository, entry);
  statSync(source);
  cpSync(source, path.join(stage, entry), { recursive: true });
}

// better-sqlite3 ships its own prebuilt binaries, so no install script has to run.
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
// pack already drops lockfiles, source maps, and declarations. Delete the lock
// anyway so the staged tree and the bundle stay the same set of files.
rmSync(path.join(stage, "package-lock.json"));

run("npx", ["-y", "@anthropic-ai/mcpb@2", "pack", stage, bundle], repository);
rmSync(stage, { recursive: true, force: true });

const size = statSync(bundle).size;
process.stdout.write(`bundle: ${path.relative(repository, bundle)} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
