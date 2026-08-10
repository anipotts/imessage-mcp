import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const serverJson = JSON.parse(readFileSync(resolve(ROOT, "server.json"), "utf8"));
const pluginJson = JSON.parse(readFileSync(
  resolve(ROOT, ".claude-plugin", "plugin.json"),
  "utf8",
));

describe("1.3.1 release metadata", () => {
  it("keeps package, MCP Registry, and Claude plugin versions aligned", () => {
    expect(packageJson.version).toBe("1.3.1");
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages[0].version).toBe(packageJson.version);
    expect(pluginJson.version).toBe(packageJson.version);
  });

  it("ships the native unified-contact helper", () => {
    expect(packageJson.files).toContain("native");
    expect(() => readFileSync(resolve(ROOT, "native", "contact-resolver.js"))).not.toThrow();
  });

  it("retains the declared 1.x Node compatibility floor", () => {
    expect(packageJson.engines.node).toBe(">=18");
  });
});
