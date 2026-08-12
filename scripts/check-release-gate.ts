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

assert.fail("stable publication is fail-closed until a protected, immutable seven-day canary attestation is implemented and verified");
