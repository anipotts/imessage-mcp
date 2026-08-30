#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const RUNTIME_PREFIXES = ["package/bin/", "package/dist/", "package/native/"];

function entries(archive: string): string[] {
  const output = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return output.split(/\r?\n/u).filter(Boolean).sort();
}

function bytes(archive: string, entry: string): Buffer {
  return execFileSync("tar", ["-xOzf", archive, entry], { maxBuffer: MAX_ENTRY_BYTES });
}

function json<T>(archive: string, entry: string): T {
  const value = bytes(archive, entry);
  assert.ok(value.length > 0 && value.length < MAX_ENTRY_BYTES, `${entry} is outside the comparison limit`);
  return JSON.parse(value.toString("utf8")) as T;
}

const [baselineArchive, candidateArchive, baselineVersion, candidateVersion, baselineLockFile, candidateLockFile] =
  process.argv.slice(2);
assert.ok(baselineArchive && candidateArchive && baselineVersion && candidateVersion && baselineLockFile && candidateLockFile,
  "usage: check-runtime-equality.ts <baseline.tgz> <candidate.tgz> <baseline-version> <candidate-version> <baseline-lock> <candidate-lock>");
assert.equal(readFileSync(baselineArchive).subarray(0, 2).toString("hex"), "1f8b", "baseline must be gzip data");
assert.equal(readFileSync(candidateArchive).subarray(0, 2).toString("hex"), "1f8b", "candidate must be gzip data");

const baselineEntries = entries(baselineArchive);
const candidateEntries = entries(candidateArchive);
for (const list of [baselineEntries, candidateEntries]) {
  assert.ok(list.length > 0 && list.every((entry) => entry.startsWith("package/") && !entry.includes("../")),
    "package contains an unsafe archive path");
}

const baselineRuntime = baselineEntries.filter((entry) => RUNTIME_PREFIXES.some((prefix) => entry.startsWith(prefix)));
const candidateRuntime = candidateEntries.filter((entry) => RUNTIME_PREFIXES.some((prefix) => entry.startsWith(prefix)));
assert.deepEqual(candidateRuntime, baselineRuntime, "executable package paths changed from the verified runtime");
for (const entry of baselineRuntime) {
  assert.ok(bytes(baselineArchive, entry).equals(bytes(candidateArchive, entry)), `${entry} changed from the verified runtime`);
}

type PackageJson = Record<string, unknown> & { version: string };
const baselinePackage = json<PackageJson>(baselineArchive, "package/package.json");
const candidatePackage = json<PackageJson>(candidateArchive, "package/package.json");
assert.equal(baselinePackage.version, baselineVersion);
assert.equal(candidatePackage.version, candidateVersion);
for (const field of ["dependencies", "engines", "os", "bin", "type", "main", "exports"] as const) {
  assert.deepEqual(candidatePackage[field], baselinePackage[field], `package.json ${field} changed from the verified runtime`);
}

type Lockfile = { version: string; packages: Record<string, Record<string, unknown>> };
const baselineLock = JSON.parse(readFileSync(baselineLockFile, "utf8")) as Lockfile;
const candidateLock = JSON.parse(readFileSync(candidateLockFile, "utf8")) as Lockfile;
assert.equal(baselineLock.version, baselineVersion);
assert.equal(candidateLock.version, candidateVersion);
const normalizedBaseline = structuredClone(baselineLock);
const normalizedCandidate = structuredClone(candidateLock);
normalizedBaseline.version = candidateVersion;
normalizedBaseline.packages[""].version = candidateVersion;
assert.deepEqual(normalizedCandidate, normalizedBaseline, "dependency lock graph changed from the verified runtime");

process.stdout.write(`runtime equality passed: ${baselineRuntime.length} executable files and the dependency graph are unchanged\n`);
