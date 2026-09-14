import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = path.join(repository, "dist-mcpb", "imessage-mcp.mcpb");

interface Manifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  license: string;
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } };
  compatibility: { platforms: string[]; runtimes: Record<string, string> };
  user_config: Record<string, { type: string; description: string; default: string }>;
}

function json<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(repository, file), "utf8")) as T;
}

const manifest = json<Manifest>("manifest.json");
const packageJson = json<{ version: string }>("package.json");

describe("desktop bundle manifest", () => {
  it("describes the same package npm publishes", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("imessage-mcp");
    expect(manifest.display_name).toBe("iMessage");
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.license).toBe("MIT");
  });

  it("launches the packaged entry point on macOS only", () => {
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("bin/imessage-mcp.js");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args[0]).toBe("${__dirname}/bin/imessage-mcp.js");
    expect(manifest.compatibility.platforms).toEqual(["darwin"]);
    expect(manifest.compatibility.runtimes.node).toBe(">=22");
  });

  it("maps both privacy knobs into the launch arguments", () => {
    const args = manifest.server.mcp_config.args;
    for (const [flag, key] of [["--privacy", "privacy"], ["--contacts", "contacts"]]) {
      const index = args.indexOf(flag);
      expect(index).toBeGreaterThan(0);
      expect(args[index + 1]).toBe(`\${user_config.${key}}`);
    }
    expect(manifest.user_config.privacy.default).toBe("full");
    expect(manifest.user_config.contacts.default).toBe("live");
    for (const mode of ["full", "redacted", "aggregate"]) {
      expect(manifest.user_config.privacy.description).toContain(mode);
    }
    for (const mode of ["live", "none"]) {
      expect(manifest.user_config.contacts.description).toContain(mode);
    }
  });
});

describe.skipIf(!existsSync(bundle))("packed desktop bundle", () => {
  const entries = existsSync(bundle)
    ? execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" }).split("\n").filter(Boolean)
    : [];

  it("carries the runtime tree and nothing else at the top level", () => {
    const top = [...new Set(entries.map((entry) => entry.split("/")[0]))].sort();
    expect(top).toEqual(["bin", "dist", "manifest.json", "native", "node_modules", "package.json"]);
    expect(entries).toContain("bin/imessage-mcp.js");
    expect(entries).toContain("dist/index.js");
    expect(entries).toContain("native/message-text-decoder.js");
  });

  it("ships the prebuilt sqlite binary for Apple Silicon and Intel", () => {
    expect(entries).toContain("node_modules/better-sqlite3/prebuilds/darwin-arm64.node");
    expect(entries).toContain("node_modules/better-sqlite3/prebuilds/darwin-x64.node");
  });

  it("omits development dependencies and sources", () => {
    expect(entries.some((entry) => entry.startsWith("node_modules/vitest/"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("node_modules/typescript/"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("src/"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("tests/"))).toBe(false);
    expect(entries).not.toContain("package-lock.json");
  });
});
