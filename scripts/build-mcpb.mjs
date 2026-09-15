#!/usr/bin/env node

// Packs the Claude Desktop bundle. The staged tree carries only what the server
// needs at runtime, so the bundle never ships tests, sources, or dev dependencies.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPinnedPacker } from "./mcpb-packer.mjs";

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

// The server reads its handshake icons from assets/ at startup, and the manifest
// points Claude Desktop at the sized PNGs, so the icon set rides along. The demo
// GIF and other documentation images stay out of the bundle.
const manifest = JSON.parse(readFileSync(path.join(repository, "manifest.json"), "utf8"));
const iconFiles = new Set(["assets/icon.svg", manifest.icon, ...manifest.icons.map((icon) => icon.src)]);
mkdirSync(path.join(stage, "assets"), { recursive: true });
for (const file of iconFiles) {
  cpSync(path.join(repository, file), path.join(stage, file));
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

run(installPinnedPacker(packer, repository), ["pack", stage, bundle], repository);
rmSync(stage, { recursive: true, force: true });
rmSync(packer, { recursive: true, force: true });

const size = statSync(bundle).size;
process.stdout.write(`bundle: ${path.relative(repository, bundle)} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
