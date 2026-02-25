import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MAX_LIMIT } from "../src/helpers.js";

// Collect all .ts source files recursively from src/
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const SRC_DIR = path.resolve(import.meta.dirname, "..", "src");
const sourceFiles = collectTsFiles(SRC_DIR);

describe("no network imports in source files", () => {
  // These patterns would indicate outbound network capability, which a
  // read-only local MCP server should never need.
  const forbiddenPatterns = [
    /\bimport\b.*['"]node-fetch['"]/,
    /\brequire\s*\(\s*['"]node-fetch['"]\)/,
    /\bimport\b.*['"]axios['"]/,
    /\brequire\s*\(\s*['"]axios['"]\)/,
    /\bimport\b.*['"]request['"]/,
    /\brequire\s*\(\s*['"]request['"]\)/,
    /\bimport\b.*from\s+['"]node:https?['"]/,
    /\brequire\s*\(\s*['"]node:https?['"]\)/,
    /\brequire\s*\(\s*['"]https?['"]\)/,
    /\bimport\b.*from\s+['"]node:net['"]/,
    /\brequire\s*\(\s*['"]node:net['"]\)/,
    /\bglobalThis\.fetch\b/,
  ];

  it("source files do not import fetch, http, https, net, axios, or request", () => {
    const violations: string[] = [];

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, "utf-8");
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(SRC_DIR, filePath)} matches ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("MAX_LIMIT enforcement", () => {
  it("MAX_LIMIT is at most 500", () => {
    expect(MAX_LIMIT).toBeLessThanOrEqual(500);
  });

  it("MAX_LIMIT is a positive integer", () => {
    expect(MAX_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_LIMIT)).toBe(true);
  });
});

describe("tool registration functions exist and are callable", () => {
  it("all register* functions are exported and are functions", async () => {
    const modules = [
      { path: "../src/tools/messages.js", name: "registerMessageTools" },
      { path: "../src/tools/contacts.js", name: "registerContactTools" },
      { path: "../src/tools/analytics.js", name: "registerAnalyticsTools" },
      { path: "../src/tools/groups.js", name: "registerGroupTools" },
      { path: "../src/tools/attachments.js", name: "registerAttachmentTools" },
      { path: "../src/tools/reactions.js", name: "registerReactionTools" },
      { path: "../src/tools/receipts.js", name: "registerReceiptTools" },
      { path: "../src/tools/threads.js", name: "registerThreadTools" },
      { path: "../src/tools/edits.js", name: "registerEditTools" },
      { path: "../src/tools/effects.js", name: "registerEffectTools" },
      { path: "../src/tools/memories.js", name: "registerMemoryTools" },
      { path: "../src/tools/patterns.js", name: "registerPatternTools" },
      { path: "../src/tools/wrapped.js", name: "registerWrappedTools" },
    ];

    for (const mod of modules) {
      const imported = await import(mod.path);
      expect(typeof imported[mod.name]).toBe("function");
    }
  });

  it("registerHelp is exported from help module", async () => {
    const { registerHelp } = await import("../src/help.js");
    expect(typeof registerHelp).toBe("function");
  });
});
