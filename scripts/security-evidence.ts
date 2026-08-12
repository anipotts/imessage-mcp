#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

interface SecurityEvidence {
  schema_version: 2;
  repository: "anipotts/imessage-mcp";
  subject: {
    commit: string;
    tree: string;
    version: string;
    package_file: string;
    package_sha256: string;
  };
  security_scan: {
    scan_id: string;
    scan_revision: string;
    snapshot_digest: string;
    manifest_sha256: string;
    findings_sha256: string;
    coverage_sha256: string;
    producer: string;
    finding_count: 0;
    status: "passed";
  };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function trailer(message: string, key: string): string {
  const values = message.split(/\r?\n/u)
    .map((line) => line.match(new RegExp(`^${key}:\\s*(.+)$`, "u"))?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  assert.equal(values.length, 1, `signed release evidence commit must contain exactly one ${key} trailer`);
  return values[0];
}

function scanEvidence(commit: string): SecurityEvidence["security_scan"] & { tree: string } {
  const parent = git("rev-parse", `${commit}^1`);
  const tree = git("rev-parse", `${commit}^{tree}`);
  assert.equal(git("rev-parse", `${parent}^{tree}`), tree, "security evidence commit must not change the scanned tree");
  const message = git("show", "-s", "--format=%B", commit);
  const scanRevision = trailer(message, "Security-Scan-Revision");
  assert.equal(scanRevision, parent, "security scan revision must be the evidence commit's direct parent");
  const status = trailer(message, "Security-Scan-Status");
  assert.equal(status, "passed", "security scan must have passed with zero reportable findings");
  const value = {
    scan_id: trailer(message, "Security-Scan-Id"),
    scan_revision: scanRevision,
    snapshot_digest: trailer(message, "Security-Snapshot-Digest"),
    manifest_sha256: trailer(message, "Security-Scan-Manifest-SHA256"),
    findings_sha256: trailer(message, "Security-Scan-Findings-SHA256"),
    coverage_sha256: trailer(message, "Security-Scan-Coverage-SHA256"),
    producer: trailer(message, "Security-Scan-Producer"),
    finding_count: Number(trailer(message, "Security-Scan-Finding-Count")),
    status: "passed" as const,
    tree,
  };
  assert.match(value.scan_id, /^[a-f0-9-]{36}$/u);
  assert.match(value.snapshot_digest, /^codex-security-snapshot\/v1:sha256:[a-f0-9]{64}$/u);
  for (const digest of [value.manifest_sha256, value.findings_sha256, value.coverage_sha256]) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  assert.match(value.producer, /^codex-security-plugin@[0-9]+\.[0-9]+\.[0-9]+$/u);
  assert.equal(value.finding_count, 0, "security scan evidence must report zero findings");
  return value;
}

function parseEvidence(file: string): SecurityEvidence {
  return JSON.parse(readFileSync(file, "utf8")) as SecurityEvidence;
}

const [mode, packageFile, commit, evidenceFile = "security-evidence.json"] = process.argv.slice(2);
assert.ok(mode === "create" || mode === "verify", "usage: security-evidence.ts create|verify <package> <commit> [evidence]");
assert.ok(packageFile && commit);
assert.match(commit, /^[a-f0-9]{40}$/u, "evidence commit must be a full Git SHA");
assert.equal(git("rev-parse", commit), commit, "security evidence commit is not available in this checkout");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const scan = scanEvidence(commit);
const expected: SecurityEvidence = {
  schema_version: 2,
  repository: "anipotts/imessage-mcp",
  subject: {
    commit,
    tree: scan.tree,
    version: packageJson.version,
    package_file: basename(packageFile),
    package_sha256: sha256(packageFile),
  },
  security_scan: {
    scan_id: scan.scan_id,
    scan_revision: scan.scan_revision,
    snapshot_digest: scan.snapshot_digest,
    manifest_sha256: scan.manifest_sha256,
    findings_sha256: scan.findings_sha256,
    coverage_sha256: scan.coverage_sha256,
    producer: scan.producer,
    finding_count: scan.finding_count,
    status: scan.status,
  },
};

if (mode === "create") {
  writeFileSync(evidenceFile, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`created signed-commit security evidence for ${packageJson.version} at ${commit}\n`);
} else {
  assert.deepEqual(parseEvidence(evidenceFile), expected, "security evidence does not match this signed scan commit and package");
  process.stdout.write(`verified signed-commit security evidence for ${packageJson.version} at ${commit}\n`);
}
