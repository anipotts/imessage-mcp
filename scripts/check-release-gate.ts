#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface ReleaseStatus {
  schema_version: number;
  subject_version: string;
  prerelease_ready: boolean;
  prerelease_gates: Record<string, boolean>;
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

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const expected = process.argv[2] ?? packageJson.version;
assert.equal(packageJson.version, expected, "requested release version must match package.json");

const status = JSON.parse(readFileSync("release-status.json", "utf8")) as ReleaseStatus;
assert.equal(status.schema_version, 4);
assert.equal(status.subject_version, expected, "release evidence must name the exact requested version");
if (expected.includes("-")) {
  assert.equal(status.prerelease_ready, true, "prerelease publication remains blocked until every named gate is complete");
  assert.ok(Object.keys(status.prerelease_gates).length >= 7 && Object.values(status.prerelease_gates).every(Boolean),
    "prerelease requires every named automated and manual gate");
  assert.match(readFileSync("VERIFICATION.md", "utf8"), /prerelease release gate:\s*passed/iu);
  process.stdout.write(`prerelease release gate passed for ${expected}\n`);
  process.exit(0);
}

assert.match(expected, /^\d+\.\d+\.\d+$/u, "stable release version must not be a prerelease");
assert.equal(status.stable.ready, true, "stable publication remains blocked until its canary state is ready");
assert.equal(status.stable.subject_version, expected, "stable state must name the exact requested version");
assert.ok(typeof status.stable.release_candidate === "string");
assert.match(status.stable.release_candidate, new RegExp(`^${expected.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u"),
  "stable release must derive from a numbered release candidate");
assert.ok(typeof status.stable.candidate_commit === "string" && /^[a-f0-9]{40}$/u.test(status.stable.candidate_commit),
  "stable state must bind the exact release-candidate commit");
assert.ok(
  typeof status.stable.candidate_package_sha256 === "string" &&
  /^[a-f0-9]{64}$/u.test(status.stable.candidate_package_sha256),
  "stable state must bind the exact release-candidate package digest",
);
const started = Date.parse(status.stable.canary_started_at ?? "");
const completed = Date.parse(status.stable.canary_completed_at ?? "");
assert.ok(Number.isFinite(started) && Number.isFinite(completed), "stable canary timestamps must be valid");
assert.ok(completed - started >= 7 * 24 * 60 * 60 * 1_000, "stable canary must run for at least seven full days");
assert.ok(completed <= Date.now(), "stable canary completion cannot be in the future");
assert.deepEqual(Object.keys(status.stable.exercises).sort(), [
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
]);
assert.ok(Object.values(status.stable.exercises).every((value) => value === true),
  "stable release requires every named canary exercise");
assert.match(readFileSync("VERIFICATION.md", "utf8"), /stable release gate:\s*passed/iu);
process.stdout.write(`stable release state is structurally ready for protected canary attestation at ${expected}\n`);
