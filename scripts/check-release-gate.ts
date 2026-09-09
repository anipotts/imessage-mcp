#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const expected = process.argv[2] ?? packageJson.version;
assert.match(expected, /^2\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u);
assert.equal(packageJson.version, expected, "requested release version must match package.json");

// This file records local readiness. Protected CI and exact-source security
// attestations remain the publication authority for both release channels.
const status = JSON.parse(readFileSync("release-status.json", "utf8"));
assert.equal(status.schema_version, 5);
assert.equal(status.subject_version, expected, "release evidence must name the exact requested version");
assert.equal(status.channel, expected.includes("-") ? "next" : "latest");
assert.equal(status.ready, true, "release preparation is incomplete");
assert.deepEqual(Object.keys(status.gates).sort(), [
  "dependency_audit", "installed_package", "metadata_and_package_contents",
  "million_message_performance", "privacy", "protocol", "regressions",
]);
assert.ok(Object.values(status.gates).every((value) => value === true), "every named automated gate must pass");
process.stdout.write(`release preparation passed for ${expected}; publication requires protected exact-source evidence\n`);
