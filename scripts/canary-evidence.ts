#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_GIT_BYTES = 128 * 1024 * 1024;
const MAX_TARBALL_LIST_BYTES = 4 * 1024 * 1024;
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_FILES = 512;
const SCAN_PATHS = [
  "security/scan/coverage.json",
  "security/scan/findings.json",
  "security/scan/scan-manifest.json",
] as const;
const STABLE_DERIVATION_FILES = [
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "VERIFICATION.md",
  "npm-shrinkwrap.json",
  "package.json",
  "release-status.json",
  "server.json",
] as const;
const EXERCISE_KEYS = [
  "all_privacy_modes",
  "all_service_families",
  "all_seven_tools",
  "claude_code",
  "claude_desktop",
  "codex",
  "copied_database",
  "cursor",
  "http_proxy_simulation",
  "live_database",
  "stdio",
] as const;

interface ReleaseStatus {
  schema_version: number;
  subject_version: string;
  stable: {
    ready: boolean;
    subject_version: string | null;
    release_candidate: string | null;
    candidate_commit: string | null;
    candidate_package_sha256: string | null;
    canary_started_at: string | null;
    canary_completed_at: string | null;
    exercises: Record<string, boolean>;
  };
}

interface NpmCandidateMetadata {
  version: string;
  gitHead?: string;
  dist: {
    tarball: string;
    attestations: {
      url: string;
      provenance: { predicateType: string };
    };
  };
  time: Record<string, string>;
}

interface ReleaseWorkflowRun {
  conclusion: "success";
  databaseId: number;
  event: "push";
  headBranch: string;
  headSha: string;
  url: string;
  workflowName: "release 2.x";
}

interface CanaryEvidence {
  schema_version: 1;
  repository: "anipotts/imessage-mcp";
  subject: {
    stable_evidence_commit: string;
    stable_evidence_tree: string;
    stable_source_commit: string;
    stable_source_tree: string;
    stable_version: string;
    stable_package_file: string;
    stable_package_sha256: string;
  };
  release_candidate: {
    version: string;
    commit: string;
    tree: string;
    package_sha256: string;
    registry_tarball: string;
    published_at: string;
    provenance: {
      attestation_url: string;
      workflow_path: ".github/workflows/release.yml";
      workflow_ref: string;
      invocation_id: string;
      release_workflow_run_id: number;
      npm_git_head: string | null;
    };
  };
  canary: {
    completed_at: string;
    elapsed_seconds: number;
    exercises: Record<string, true>;
  };
  stable_derivation: {
    direct_parent: true;
    changed_files: string[];
    package_metadata_differences: string[];
    other_package_files_identical: true;
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: MAX_GIT_BYTES }).trim();
}

function gitBytes(...args: string[]): Buffer {
  return execFileSync("git", args, { maxBuffer: MAX_GIT_BYTES });
}

function commitFile<T>(commit: string, file: string): T {
  return JSON.parse(gitBytes("show", `${commit}:${file}`).toString("utf8")) as T;
}

function evidenceCommitSource(commit: string): { source: string; evidenceTree: string; sourceTree: string } {
  const ancestry = git("rev-list", "--parents", "-n", "1", commit).split(/\s+/u);
  assert.equal(ancestry.length, 2, "release evidence commit must have exactly one direct parent");
  const source = ancestry[1];
  const changed = git("diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", source, commit)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([AM])\t(.+)$/u);
      assert.ok(match, "release evidence commit may only add or replace canonical scan files");
      return match[2];
    })
    .sort();
  assert.deepEqual(changed, [...SCAN_PATHS].sort(),
    "release evidence commit must change exactly the three canonical scan files");
  return {
    source,
    evidenceTree: git("rev-parse", `${commit}^{tree}`),
    sourceTree: git("rev-parse", `${source}^{tree}`),
  };
}

function assertBoundedRegularFile(file: string, maximum: number, label: string): void {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum, `${label} exceeds its regular-file size limit`);
}

function packagePaths(packageFile: string): string[] {
  assertBoundedRegularFile(packageFile, MAX_TARBALL_BYTES, "package tarball");
  const paths = execFileSync("tar", ["-tzf", packageFile], {
    encoding: "utf8",
    maxBuffer: MAX_TARBALL_LIST_BYTES,
  }).split(/\r?\n/u).filter(Boolean);
  assert.ok(paths.length > 0 && paths.length <= MAX_PACKAGE_FILES, "package tarball has an invalid file count");
  const verbose = execFileSync("tar", ["-tvzf", packageFile], {
    encoding: "utf8",
    maxBuffer: MAX_TARBALL_LIST_BYTES,
  }).split(/\r?\n/u).filter(Boolean);
  assert.equal(verbose.length, paths.length, "package tarball metadata is inconsistent");
  assert.ok(verbose.every((entry) => /^[-d]/u.test(entry)), "package tarball may contain only regular files and directories");
  assert.equal(new Set(paths).size, paths.length, "package tarball paths must be unique");
  for (const entry of paths) {
    assert.ok(
      entry.startsWith("package/") &&
      !entry.startsWith("/") &&
      !entry.includes("\\") &&
      !entry.split("/").includes("..") &&
      /^[A-Za-z0-9@._/+\-]+$/u.test(entry) &&
      Buffer.byteLength(entry, "utf8") <= 1024,
      "package tarball contains an unsafe path",
    );
  }
  return paths.filter((entry) => !entry.endsWith("/")).sort();
}

function packageBytes(packageFile: string, entry: string): Buffer {
  assertBoundedRegularFile(packageFile, MAX_TARBALL_BYTES, "package tarball");
  const value = execFileSync("tar", ["-xOf", packageFile, entry], { maxBuffer: MAX_PACKAGE_FILE_BYTES });
  assert.ok(value.length <= MAX_PACKAGE_FILE_BYTES, "package file exceeds the comparison limit");
  return value;
}

function packageJson<T>(packageFile: string, entry: string): T {
  return JSON.parse(packageBytes(packageFile, entry).toString("utf8")) as T;
}

function exactTimestamp(value: string | null, label: string): number {
  assert.ok(typeof value === "string", `${label} is required`);
  const milliseconds = Date.parse(value);
  assert.ok(Number.isFinite(milliseconds), `${label} must be an ISO timestamp`);
  return milliseconds;
}

function readMetadata(file: string): NpmCandidateMetadata {
  assertBoundedRegularFile(file, 1024 * 1024, "npm candidate metadata");
  const value = JSON.parse(readFileSync(file, "utf8")) as NpmCandidateMetadata;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "npm candidate metadata must be an object");
  assert.ok(value.dist && typeof value.dist.tarball === "string", "npm candidate metadata must include its tarball URL");
  assert.ok(
    value.dist.attestations && typeof value.dist.attestations.url === "string" &&
    value.dist.attestations.provenance?.predicateType === "https://slsa.dev/provenance/v1",
    "npm candidate metadata must include SLSA provenance",
  );
  assert.ok(value.time && typeof value.time === "object" && !Array.isArray(value.time),
    "npm candidate metadata must include registry publication times");
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function candidateProvenance(input: {
  version: string;
  commit: string;
  packageFile: string;
  metadata: NpmCandidateMetadata;
  attestationsFile: string;
  releaseRunFile: string;
}): CanaryEvidence["release_candidate"]["provenance"] {
  assert.match(
    input.metadata.dist.attestations.url,
    new RegExp(`^https://registry\\.npmjs\\.org/-/npm/v1/attestations/imessage-mcp@${input.version.replaceAll(".", "\\.")}$`, "u"),
    "candidate attestation bundle must come from the public npm registry",
  );
  assertBoundedRegularFile(input.attestationsFile, 4 * 1024 * 1024, "npm provenance bundle");
  const attestationRoot = record(JSON.parse(readFileSync(input.attestationsFile, "utf8")), "npm provenance bundle");
  assert.ok(Array.isArray(attestationRoot.attestations), "npm provenance bundle must contain attestations");
  const matches = attestationRoot.attestations.filter((entry) =>
    record(entry, "npm attestation").predicateType === "https://slsa.dev/provenance/v1",
  );
  assert.equal(matches.length, 1, "npm provenance bundle must contain one SLSA statement");
  const bundle = record(record(matches[0], "npm provenance attestation").bundle, "npm provenance bundle body");
  const envelope = record(bundle.dsseEnvelope, "npm provenance DSSE envelope");
  assert.ok(typeof envelope.payload === "string" && envelope.payload.length <= 1024 * 1024,
    "npm provenance payload is malformed");
  const payload = Buffer.from(envelope.payload, "base64");
  assert.ok(payload.length > 0, "npm provenance payload is empty");
  const statement = record(JSON.parse(payload.toString("utf8")), "npm provenance statement");
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  assert.ok(Array.isArray(statement.subject) && statement.subject.length === 1,
    "npm provenance must bind exactly one package subject");
  const subject = record(statement.subject[0], "npm provenance subject");
  assert.equal(subject.name, `pkg:npm/imessage-mcp@${input.version}`);
  const digest = record(subject.digest, "npm provenance package digest");
  assert.equal(
    digest.sha512,
    createHash("sha512").update(readFileSync(input.packageFile)).digest("hex"),
    "npm provenance must bind the downloaded release-candidate package",
  );
  const predicate = record(statement.predicate, "npm provenance predicate");
  const build = record(predicate.buildDefinition, "npm provenance build definition");
  assert.equal(build.buildType, "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1");
  const external = record(build.externalParameters, "npm provenance external parameters");
  const workflow = record(external.workflow, "npm provenance workflow");
  const expectedRef = `refs/tags/v${input.version}`;
  assert.deepEqual(workflow, {
    ref: expectedRef,
    repository: "https://github.com/anipotts/imessage-mcp",
    path: ".github/workflows/release.yml",
  });
  assert.ok(Array.isArray(build.resolvedDependencies) && build.resolvedDependencies.length === 1,
    "npm provenance must resolve one source revision");
  const dependency = record(build.resolvedDependencies[0], "npm provenance source revision");
  assert.equal(dependency.uri, `git+https://github.com/anipotts/imessage-mcp@${expectedRef}`);
  assert.equal(record(dependency.digest, "npm provenance source digest").gitCommit, input.commit);
  const internal = record(build.internalParameters, "npm provenance internal parameters");
  assert.equal(record(internal.github, "npm provenance GitHub parameters").event_name, "push");
  const runDetails = record(predicate.runDetails, "npm provenance run details");
  assert.equal(record(runDetails.builder, "npm provenance builder").id,
    "https://github.com/actions/runner/github-hosted");
  const invocation = record(runDetails.metadata, "npm provenance run metadata").invocationId;
  assert.ok(typeof invocation === "string", "npm provenance invocation id is required");

  assertBoundedRegularFile(input.releaseRunFile, 64 * 1024, "GitHub release workflow metadata");
  const releaseRun = JSON.parse(readFileSync(input.releaseRunFile, "utf8")) as ReleaseWorkflowRun;
  assert.ok(Number.isSafeInteger(releaseRun.databaseId) && releaseRun.databaseId > 0,
    "release workflow run id is invalid");
  assert.deepEqual({
    conclusion: releaseRun.conclusion,
    event: releaseRun.event,
    headBranch: releaseRun.headBranch,
    headSha: releaseRun.headSha,
    workflowName: releaseRun.workflowName,
  }, {
    conclusion: "success",
    event: "push",
    headBranch: `v${input.version}`,
    headSha: input.commit,
    workflowName: "release 2.x",
  });
  assert.equal(releaseRun.url,
    `https://github.com/anipotts/imessage-mcp/actions/runs/${releaseRun.databaseId}`);
  assert.match(invocation,
    new RegExp(`^https://github\\.com/anipotts/imessage-mcp/actions/runs/${releaseRun.databaseId}/attempts/[1-9]\\d*$`, "u"),
    "npm provenance and successful GitHub release run must identify the same workflow invocation");
  if (input.metadata.gitHead !== undefined) {
    assert.equal(input.metadata.gitHead, input.commit, "npm gitHead conflicts with the provenance source commit");
  }
  return {
    attestation_url: input.metadata.dist.attestations.url,
    workflow_path: ".github/workflows/release.yml",
    workflow_ref: expectedRef,
    invocation_id: invocation,
    release_workflow_run_id: releaseRun.databaseId,
    npm_git_head: input.metadata.gitHead ?? null,
  };
}

function stableDerivation(candidateCommit: string, stableSource: string): string[] {
  assert.equal(git("rev-parse", `${stableSource}^`), candidateCommit,
    "stable source must be the direct child of the canaried release-candidate evidence commit");
  const changed = git("diff", "--name-status", "--no-renames", candidateCommit, stableSource)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^M\t(.+)$/u);
      assert.ok(match, "stable derivation may only modify existing release metadata files");
      return match[1];
    })
    .sort();
  assert.deepEqual(changed, [...STABLE_DERIVATION_FILES].sort(),
    "stable derivation must modify exactly the reviewed version and verification metadata");
  return changed;
}

function comparePackages(candidatePackage: string, stablePackage: string): string[] {
  const candidatePaths = packagePaths(candidatePackage);
  const stablePaths = packagePaths(stablePackage);
  assert.deepEqual(stablePaths, candidatePaths, "stable and release-candidate packages must contain identical paths");
  const allowed = new Set(STABLE_DERIVATION_FILES.map((file) => `package/${file}`));
  const differences: string[] = [];
  let comparedBytes = 0;
  for (const entry of candidatePaths) {
    const candidate = packageBytes(candidatePackage, entry);
    const stable = packageBytes(stablePackage, entry);
    comparedBytes += candidate.length + stable.length;
    assert.ok(comparedBytes <= 64 * 1024 * 1024, "package comparison exceeds its total byte limit");
    const same = candidate.equals(stable);
    if (!same) differences.push(entry);
    if (!allowed.has(entry)) assert.equal(same, true, `${entry} changed after the release-candidate canary`);
  }
  assert.deepEqual(differences.sort(), [...allowed].sort(),
    "stable package must differ only in, and must update all, reviewed release metadata files");
  return differences.sort();
}

function expectedEvidence(
  stablePackage: string,
  stableCommit: string,
  candidatePackage: string,
  npmMetadataFile: string,
  npmAttestationsFile: string,
  releaseRunFile: string,
): CanaryEvidence {
  assert.match(stableCommit, /^[a-f0-9]{40}$/u, "stable evidence commit must be a full Git SHA");
  assert.equal(git("rev-parse", stableCommit), stableCommit, "stable evidence commit is unavailable");
  const stableShape = evidenceCommitSource(stableCommit);
  const stablePackageJson = packageJson<{ version: string }>(stablePackage, "package/package.json");
  const status = commitFile<ReleaseStatus>(stableCommit, "release-status.json");
  assert.equal(status.schema_version, 4);
  assert.equal(status.subject_version, stablePackageJson.version);
  assert.match(stablePackageJson.version, /^\d+\.\d+\.\d+$/u, "stable package version must not be a prerelease");
  assert.equal(status.stable.ready, true, "stable release state must be explicitly ready");
  assert.equal(status.stable.subject_version, stablePackageJson.version);

  const candidateVersion = status.stable.release_candidate;
  const candidateCommit = status.stable.candidate_commit;
  const candidateDigest = status.stable.candidate_package_sha256;
  assert.ok(typeof candidateVersion === "string");
  assert.match(
    candidateVersion,
    new RegExp(`^${stablePackageJson.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u"),
    "stable release must derive from a numbered release candidate",
  );
  assert.ok(typeof candidateCommit === "string" && /^[a-f0-9]{40}$/u.test(candidateCommit),
    "candidate commit must be a full Git SHA");
  assert.ok(typeof candidateDigest === "string" && /^[a-f0-9]{64}$/u.test(candidateDigest),
    "candidate package digest must be SHA-256");
  assert.equal(git("rev-parse", `refs/tags/v${candidateVersion}^{commit}`), candidateCommit,
    "release-candidate tag must still resolve to the published candidate commit");
  const candidateShape = evidenceCommitSource(candidateCommit);
  const candidatePackageJson = packageJson<{ version: string }>(candidatePackage, "package/package.json");
  assert.equal(candidatePackageJson.version, candidateVersion);
  assert.equal(commitFile<{ version: string }>(candidateCommit, "package.json").version, candidateVersion);
  assert.equal(sha256(readFileSync(candidatePackage)), candidateDigest,
    "downloaded release-candidate package does not match the recorded digest");

  const metadata = readMetadata(npmMetadataFile);
  assert.equal(metadata.version, candidateVersion);
  assert.equal(metadata.dist.tarball,
    `https://registry.npmjs.org/imessage-mcp/-/imessage-mcp-${candidateVersion}.tgz`,
    "candidate tarball must come from the public npm registry");
  const provenance = candidateProvenance({
    version: candidateVersion,
    commit: candidateCommit,
    packageFile: candidatePackage,
    metadata,
    attestationsFile: npmAttestationsFile,
    releaseRunFile,
  });
  const publishedAt = metadata.time[candidateVersion];
  const publishedMilliseconds = exactTimestamp(publishedAt ?? null, "npm candidate publication time");
  const startedMilliseconds = exactTimestamp(status.stable.canary_started_at, "canary start time");
  const completedMilliseconds = exactTimestamp(status.stable.canary_completed_at, "canary completion time");
  assert.equal(startedMilliseconds, publishedMilliseconds,
    "canary start must equal the immutable npm release-candidate publication time");
  assert.ok(completedMilliseconds - startedMilliseconds >= SEVEN_DAYS_MS,
    "release-candidate canary must run for at least seven full days");
  assert.ok(completedMilliseconds <= Date.now(), "canary completion cannot be in the future");

  assert.deepEqual(Object.keys(status.stable.exercises).sort(), [...EXERCISE_KEYS].sort(),
    "stable canary must name the complete exercise matrix");
  assert.ok(Object.values(status.stable.exercises).every((value) => value === true),
    "every stable canary exercise must be complete");
  const exercises = Object.fromEntries(
    [...EXERCISE_KEYS].sort().map((key) => [key, true] as const),
  ) as Record<string, true>;

  const changedFiles = stableDerivation(candidateCommit, stableShape.source);
  const packageDifferences = comparePackages(candidatePackage, stablePackage);
  assert.equal(commitFile<{ version: string }>(stableShape.source, "package.json").version, stablePackageJson.version);

  return {
    schema_version: 1,
    repository: "anipotts/imessage-mcp",
    subject: {
      stable_evidence_commit: stableCommit,
      stable_evidence_tree: stableShape.evidenceTree,
      stable_source_commit: stableShape.source,
      stable_source_tree: stableShape.sourceTree,
      stable_version: stablePackageJson.version,
      stable_package_file: basename(stablePackage),
      stable_package_sha256: sha256(readFileSync(stablePackage)),
    },
    release_candidate: {
      version: candidateVersion,
      commit: candidateCommit,
      tree: candidateShape.evidenceTree,
      package_sha256: candidateDigest,
      registry_tarball: metadata.dist.tarball,
      published_at: new Date(publishedMilliseconds).toISOString(),
      provenance,
    },
    canary: {
      completed_at: new Date(completedMilliseconds).toISOString(),
      elapsed_seconds: Math.floor((completedMilliseconds - startedMilliseconds) / 1_000),
      exercises,
    },
    stable_derivation: {
      direct_parent: true,
      changed_files: changedFiles,
      package_metadata_differences: packageDifferences,
      other_package_files_identical: true,
    },
  };
}

const [
  mode,
  stablePackage,
  stableCommit,
  candidatePackage,
  npmMetadataFile,
  npmAttestationsFile,
  releaseRunFile,
  evidenceFile = "canary-evidence.json",
] = process.argv.slice(2);
assert.ok(mode === "create" || mode === "verify",
  "usage: canary-evidence.ts create|verify <stable-package> <stable-commit> <candidate-package> <npm-metadata> <npm-attestations> <release-run> [evidence]");
assert.ok(stablePackage && stableCommit && candidatePackage && npmMetadataFile && npmAttestationsFile && releaseRunFile);
const expected = expectedEvidence(
  stablePackage,
  stableCommit,
  candidatePackage,
  npmMetadataFile,
  npmAttestationsFile,
  releaseRunFile,
);
if (mode === "create") {
  writeFileSync(evidenceFile, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`created protected canary evidence for ${expected.subject.stable_version} at ${stableCommit}\n`);
} else {
  assert.deepEqual(JSON.parse(readFileSync(evidenceFile, "utf8")), expected,
    "canary evidence does not match the public candidate, stable package, or reviewed derivation");
  process.stdout.write(`verified protected canary evidence for ${expected.subject.stable_version} at ${stableCommit}\n`);
}
