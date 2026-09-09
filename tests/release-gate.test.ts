import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

it.each(["2.0.0-rc.2", "2.0.0"])("checks exact release readiness without a predecessor or waiting period: %s", (version) => {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-release-gate-"));
  const status = {
    schema_version: 5, subject_version: version, channel: version.includes("-") ? "next" : "latest", ready: true,
    gates: {
      dependency_audit: true, installed_package: true, metadata_and_package_contents: true,
      million_message_performance: true, privacy: true, protocol: true, regressions: true,
    },
  };
  const save = () => writeFileSync(path.join(directory, "release-status.json"), JSON.stringify(status));
  const run = (requested = version) => execFileSync(process.execPath, [
    "--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("../scripts/check-release-gate.ts", import.meta.url)), requested,
  ], { cwd: directory, stdio: "pipe", encoding: "utf8" });
  try {
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version, type: "module" }));
    save();
    expect(run()).toContain(`release preparation passed for ${version}`);
    expect(() => run("2.0.1")).toThrow();
    status.gates.privacy = false;
    save();
    expect(() => run()).toThrow();
    status.gates.privacy = true;
    status.subject_version = "2.0.1";
    save();
    expect(() => run()).toThrow();
    status.subject_version = version;
    status.ready = false;
    save();
    expect(() => run()).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
