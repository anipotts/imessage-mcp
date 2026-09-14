#!/usr/bin/env node

// Packs the Claude Desktop bundle. The staged tree carries only what the server
// needs at runtime, so the bundle never ships tests, sources, or dev dependencies.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The packer writes the artifact users double-click, so it is pinned the way
// every other external component in the release path is pinned. To move it,
// run `npm pack @anthropic-ai/mcpb@<version>` and paste the tarball's sha256.
const PACKER_VERSION = "2.1.2";
const PACKER_SHA256 = "81174993380eb930bcacecc890b1acfdb06cf336366e445404aea36467417cc1";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(repository, "dist-mcpb");
const stage = path.join(output, "stage");
const packer = path.join(output, "packer");
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

// better-sqlite3 ships one prebuilt binary per platform. The manifest limits the
// bundle to darwin, so only the two Mac binaries stay; the rest is dead weight
// that would otherwise ship to every user.
const prebuilds = path.join(stage, "node_modules", "better-sqlite3", "prebuilds");
for (const name of readdirSync(prebuilds)) {
  if (!name.startsWith("darwin-")) rmSync(path.join(prebuilds, name), { recursive: true, force: true });
}
for (const required of ["darwin-arm64.node", "darwin-x64.node"]) {
  try {
    statSync(path.join(prebuilds, required));
  } catch {
    throw new Error(`better-sqlite3 no longer ships prebuilds/${required}; the desktop bundle needs both Mac binaries`);
  }
}

// Fetch the packer by exact version and refuse to run it unless the tarball is
// the reviewed one, rather than executing whatever a floating major resolves to.
mkdirSync(packer, { recursive: true });
const tarball = path.join(packer, `anthropic-ai-mcpb-${PACKER_VERSION}.tgz`);
run("npm", ["pack", `@anthropic-ai/mcpb@${PACKER_VERSION}`, "--silent", "--pack-destination", packer], repository);
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (digest !== PACKER_SHA256) {
  throw new Error(`@anthropic-ai/mcpb@${PACKER_VERSION} sha256 ${digest} does not match the pinned ${PACKER_SHA256}`);
}
run("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", packer, tarball], repository);

run(path.join(packer, "node_modules", ".bin", "mcpb"), ["pack", stage, bundle], repository);
rmSync(stage, { recursive: true, force: true });
rmSync(packer, { recursive: true, force: true });

const size = statSync(bundle).size;
process.stdout.write(`bundle: ${path.relative(repository, bundle)} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
