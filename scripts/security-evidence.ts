#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const SCAN_DIRECTORY = "security/scan";
const SCAN_PATHS = [
  `${SCAN_DIRECTORY}/coverage.json`,
  `${SCAN_DIRECTORY}/findings.json`,
  `${SCAN_DIRECTORY}/scan-manifest.json`,
] as const;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FINDINGS_BYTES = 128 * 1024 * 1024;
const MAX_COVERAGE_BYTES = 32 * 1024 * 1024;
const EXPECTED_SCAN_PRODUCER = "codex-security-plugin@0.1.22";

interface SecurityEvidence {
  schema_version: 3;
  repository: "anipotts/imessage-mcp";
  subject: {
    commit: string;
    tree: string;
    scanned_commit: string;
    scanned_tree: string;
    version: string;
    package_file: string;
    package_sha256: string;
  };
  security_scan: {
    scan_id: string;
    scan_revision: string;
    target_kind: "git_revision";
    manifest_path: string;
    manifest_sha256: string;
    findings_sha256: string;
    coverage_sha256: string;
    producer: string;
    finding_count: 0;
    coverage: "complete";
    status: "passed";
  };
}

interface VerifiedScanBundle {
  scanId: string;
  scanRevision: string;
  producer: string;
  manifestSha256: string;
  findingsSha256: string;
  coverageSha256: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).trim();
}

function gitBytes(...args: string[]): Buffer {
  return execFileSync("git", args, { maxBuffer: MAX_FINDINGS_BYTES + 1024 * 1024 });
}

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function jsonCommitFile(commit: string, file: string, maxBytes: number): { bytes: Buffer; value: Record<string, unknown> } {
  const entry = git("ls-tree", commit, "--", file);
  const separator = entry.indexOf("\t");
  assert.ok(separator > 0, `${file} must exist as a Git blob`);
  assert.match(entry.slice(0, separator), /^100644 blob [a-f0-9]{40}$/u,
    `${file} must be a regular non-executable Git blob`);
  assert.equal(entry.slice(separator + 1), file, `${file} must use its canonical repository path`);
  const bytes = gitBytes("show", `${commit}:${file}`);
  assert.ok(bytes.length > 0 && bytes.length <= maxBytes, `${file} exceeds its canonical size limit`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    assert.fail(`${file} must contain valid UTF-8 JSON`);
  }
  return { bytes, value: object(parsed, file) };
}

function exactStringArray(value: unknown, expected: string[], label: string): void {
  assert.ok(Array.isArray(value) && value.every((entry) => typeof entry === "string"), `${label} must be a string array`);
  assert.deepEqual(value, expected, `${label} must match the whole-repository scan scope`);
}

function verifyEvidenceCommitShape(commit: string): { parent: string; tree: string; parentTree: string } {
  const ancestry = git("rev-list", "--parents", "-n", "1", commit).split(/\s+/u);
  assert.equal(ancestry.length, 2, "security evidence commit must have exactly one direct parent");
  const parent = ancestry[1];
  const changed = git("diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", parent, commit)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([AM])\t(.+)$/u);
      assert.ok(match, "security evidence commit may only add or replace canonical scan files");
      return match[2];
    })
    .sort();
  assert.deepEqual(changed, [...SCAN_PATHS].sort(),
    "security evidence commit must change exactly the three canonical scan files");
  return {
    parent,
    tree: git("rev-parse", `${commit}^{tree}`),
    parentTree: git("rev-parse", `${parent}^{tree}`),
  };
}

function verifyScanBundle(commit: string, parent: string): VerifiedScanBundle {
  const manifestFile = jsonCommitFile(commit, `${SCAN_DIRECTORY}/scan-manifest.json`, MAX_MANIFEST_BYTES);
  const findingsFile = jsonCommitFile(commit, `${SCAN_DIRECTORY}/findings.json`, MAX_FINDINGS_BYTES);
  const coverageFile = jsonCommitFile(commit, `${SCAN_DIRECTORY}/coverage.json`, MAX_COVERAGE_BYTES);
  const manifest = manifestFile.value;
  assert.equal(manifest.documentType, "codex-security.scan-manifest");
  assert.equal(manifest.schemaVersion, "1.0");
  const scan = object(manifest.scan, "scan-manifest scan");
  assert.equal(scan.status, "completed");
  assert.ok(typeof scan.sealedAt === "string" && Number.isFinite(Date.parse(scan.sealedAt)),
    "security scan must have a valid sealedAt timestamp");
  assert.ok(typeof scan.id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(scan.id),
    "security scan id must be a UUID");
  const producer = object(scan.producer, "security scan producer");
  assert.equal(producer.name, "codex-security-plugin");
  assert.equal(producer.version, EXPECTED_SCAN_PRODUCER.split("@")[1],
    "security scan producer version must match the reviewed release gate");
  const target = object(scan.target, "security scan target");
  assert.equal(target.kind, "git_revision", "release scans must target an immutable Git revision");
  assert.equal(target.revision, parent, "sealed scan must target the evidence commit's direct parent");
  assert.equal(target.displayName, "imessage-mcp");
  assert.ok(typeof target.targetId === "string" && /^target_sha256_[a-f0-9]{64}$/u.test(target.targetId),
    "security scan target id is malformed");
  assert.equal(target.snapshotDigest, undefined,
    "clean git_revision scans bind the exact revision and must not substitute a worktree snapshot digest");
  const scope = object(scan.scope, "security scan scope");
  exactStringArray(scope.includePaths, ["."], "security scan includePaths");
  exactStringArray(scope.excludePaths, [], "security scan excludePaths");
  assert.equal(scan.coverageRef, "coverage.json");
  assert.equal(scan.findingsRef, "findings.json");

  const findings = findingsFile.value;
  assert.equal(findings.documentType, "codex-security.findings");
  assert.equal(findings.schemaVersion, "1.0");
  assert.equal(findings.scanId, scan.id);
  assert.ok(Array.isArray(findings.findings));
  assert.equal(findings.findings.length, 0, "release security scan must have zero reportable findings");

  const coverage = coverageFile.value;
  assert.equal(coverage.documentType, "codex-security.coverage");
  assert.equal(coverage.schemaVersion, "1.0");
  assert.equal(coverage.scanId, scan.id);
  assert.equal(coverage.mode, "repository");
  assert.equal(coverage.completeness, "complete", "release security scan coverage must be complete");
  assert.equal(coverage.inventoryStrategy, "repository");
  exactStringArray(coverage.includePaths, ["."], "coverage includePaths");
  exactStringArray(coverage.excludePaths, [], "coverage excludePaths");
  assert.ok(Array.isArray(coverage.surfaces) && coverage.surfaces.length > 0,
    "complete coverage must contain reviewed surfaces");
  for (const [index, rawSurface] of coverage.surfaces.entries()) {
    const surface = object(rawSurface, `coverage surface ${index}`);
    assert.ok(["no_issue_found", "rejected", "not_applicable"].includes(String(surface.disposition)),
      "zero-finding release coverage cannot contain reported or follow-up surfaces");
  }
  assert.ok(Array.isArray(coverage.explicitExclusions) && coverage.explicitExclusions.length === 0,
    "whole-repository release scan cannot contain explicit exclusions");
  assert.ok(Array.isArray(coverage.deferred) && coverage.deferred.length === 0,
    "complete release scan cannot contain deferred work");
  assert.ok(coverage.openQuestions === undefined || (Array.isArray(coverage.openQuestions) && coverage.openQuestions.length === 0),
    "release scan cannot contain unresolved open questions");

  assert.ok(Array.isArray(scan.artifacts) && scan.artifacts.length === 2,
    "sealed scan manifest must bind exactly findings.json and coverage.json");
  const actualArtifacts = new Map<string, { sha256: string; mediaType: string }>();
  for (const rawArtifact of scan.artifacts) {
    const artifact = object(rawArtifact, "security scan artifact");
    assert.ok(typeof artifact.path === "string" && typeof artifact.sha256 === "string" &&
      typeof artifact.mediaType === "string", "security scan artifact is malformed");
    assert.ok(!actualArtifacts.has(artifact.path), "security scan artifact paths must be unique");
    actualArtifacts.set(artifact.path, { sha256: artifact.sha256, mediaType: artifact.mediaType });
  }
  assert.deepEqual(actualArtifacts.get("findings.json"), {
    sha256: sha256(findingsFile.bytes),
    mediaType: "application/json",
  });
  assert.deepEqual(actualArtifacts.get("coverage.json"), {
    sha256: sha256(coverageFile.bytes),
    mediaType: "application/json",
  });
  assert.deepEqual([...actualArtifacts.keys()].sort(), ["coverage.json", "findings.json"]);

  return {
    scanId: scan.id,
    scanRevision: parent,
    producer: EXPECTED_SCAN_PRODUCER,
    manifestSha256: sha256(manifestFile.bytes),
    findingsSha256: sha256(findingsFile.bytes),
    coverageSha256: sha256(coverageFile.bytes),
  };
}

function parseEvidence(file: string): SecurityEvidence {
  return JSON.parse(readFileSync(file, "utf8")) as SecurityEvidence;
}

const [mode, packageFile, commit, evidenceFile = "security-evidence.json"] = process.argv.slice(2);
assert.ok(mode === "create" || mode === "verify", "usage: security-evidence.ts create|verify <package> <commit> [evidence]");
assert.ok(packageFile && commit);
assert.match(commit, /^[a-f0-9]{40}$/u, "evidence commit must be a full Git SHA");
assert.equal(git("rev-parse", commit), commit, "security evidence commit is not available in this checkout");
const commitShape = verifyEvidenceCommitShape(commit);
const scan = verifyScanBundle(commit, commitShape.parent);
const packageJson = JSON.parse(gitBytes("show", `${commit}:package.json`).toString("utf8")) as { version: string };
assert.ok(typeof packageJson.version === "string" && packageJson.version.length > 0);
const expected: SecurityEvidence = {
  schema_version: 3,
  repository: "anipotts/imessage-mcp",
  subject: {
    commit,
    tree: commitShape.tree,
    scanned_commit: commitShape.parent,
    scanned_tree: commitShape.parentTree,
    version: packageJson.version,
    package_file: basename(packageFile),
    package_sha256: sha256(readFileSync(packageFile)),
  },
  security_scan: {
    scan_id: scan.scanId,
    scan_revision: scan.scanRevision,
    target_kind: "git_revision",
    manifest_path: `${SCAN_DIRECTORY}/scan-manifest.json`,
    manifest_sha256: scan.manifestSha256,
    findings_sha256: scan.findingsSha256,
    coverage_sha256: scan.coverageSha256,
    producer: scan.producer,
    finding_count: 0,
    coverage: "complete",
    status: "passed",
  },
};

if (mode === "create") {
  writeFileSync(evidenceFile, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`created sealed scan and package evidence for ${packageJson.version} at ${commit}\n`);
} else {
  assert.deepEqual(parseEvidence(evidenceFile), expected,
    "security evidence does not match this signed scan-bundle commit and package");
  process.stdout.write(`verified sealed scan and package evidence for ${packageJson.version} at ${commit}\n`);
}
