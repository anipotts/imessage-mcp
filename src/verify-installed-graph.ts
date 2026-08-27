#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

interface PackageRecord {
  name: string;
  version: string;
}

interface LockEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
}

interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, LockEntry & { dependencies?: Record<string, string> }>;
}

function packageNameFromLockPath(lockPath: string): string {
  const match = lockPath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u);
  assert.ok(match, `unsupported shrinkwrap package path: ${lockPath}`);
  return match[1];
}

function packageDirectories(nodeModules: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const entryPath = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), `invalid installed scope: ${entryPath}`);
      for (const child of readdirSync(entryPath, { withFileTypes: true })) {
        const childPath = path.join(entryPath, child.name);
        assert.ok(child.isDirectory() && !child.isSymbolicLink(), `invalid installed package: ${childPath}`);
        result.push(childPath);
      }
      continue;
    }
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), `invalid installed package: ${entryPath}`);
    result.push(entryPath);
  }
  return result;
}

function installedPackages(installRoot: string): PackageRecord[] {
  const root = realpathSync(installRoot);
  const queue = [path.join(root, "node_modules")];
  const seen = new Set<string>();
  const packages: PackageRecord[] = [];
  while (queue.length) {
    const nodeModules = queue.shift() as string;
    if (seen.has(nodeModules)) continue;
    seen.add(nodeModules);
    for (const packageDirectory of packageDirectories(nodeModules)) {
      const stat = lstatSync(packageDirectory);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `installed package must be a real directory: ${packageDirectory}`);
      const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as Partial<PackageRecord>;
      assert.ok(typeof manifest.name === "string" && typeof manifest.version === "string", `installed package has invalid metadata: ${packageDirectory}`);
      packages.push({ name: manifest.name, version: manifest.version });
      const nested = path.join(packageDirectory, "node_modules");
      try {
        if (lstatSync(nested).isDirectory()) queue.push(nested);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return packages;
}

function sortedPairs(values: PackageRecord[]): string[] {
  return values.map((value) => `${value.name}@${value.version}`).sort();
}

export function verifyInstalledGraph(installRoot: string, lockfilePath: string): void {
  const lock = JSON.parse(readFileSync(lockfilePath, "utf8")) as Lockfile;
  assert.equal(lock.lockfileVersion, 3, "reviewed runtime graph requires package-lock lockfileVersion 3");
  assert.ok(lock.packages && typeof lock.packages === "object");
  const root = lock.packages[""];
  assert.ok(root?.dependencies && typeof root.dependencies === "object", "shrinkwrap root dependencies are missing");
  for (const [name, version] of Object.entries(root.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, `runtime dependency ${name} is not exactly pinned`);
  }

  const expected = Object.entries(lock.packages)
    .filter(([lockPath, entry]) => lockPath.length > 0 && entry.dev !== true)
    .map(([lockPath, entry]) => {
      assert.match(entry.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, `invalid locked version at ${lockPath}`);
      return { name: packageNameFromLockPath(lockPath), version: entry.version as string };
    });
  assert.equal(new Set(sortedPairs(expected)).size, expected.length, "production lock graph contains duplicate name/version records");

  const actual = installedPackages(installRoot);
  const packageRoot = actual.find((record) => record.name === "imessage-mcp");
  assert.ok(packageRoot, "installed graph does not contain imessage-mcp");
  const runtime = actual.filter((record) => record.name !== "imessage-mcp");
  assert.deepEqual(sortedPairs(runtime), sortedPairs(expected), "installed production graph differs from the reviewed lock graph");
}

const [installRoot, lockfilePath] = process.argv.slice(2);
assert.ok(installRoot && lockfilePath, "usage: verify-installed-graph <install-root> <reviewed-package-lock>");
verifyInstalledGraph(installRoot, lockfilePath);
process.stdout.write("verified exact installed production graph against reviewed package lock\n");
