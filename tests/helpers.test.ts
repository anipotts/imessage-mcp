import { describe, it, expect } from "vitest";
import { clamp, formatResults, DEFAULT_LIMIT, MAX_LIMIT } from "../src/helpers.js";

describe("clamp()", () => {
  it("clamps a value below the minimum to the minimum", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(0, 1, 10)).toBe(1);
  });

  it("clamps a value above the maximum to the maximum", () => {
    expect(clamp(200, 0, 100)).toBe(100);
    expect(clamp(11, 1, 10)).toBe(10);
  });

  it("returns the value unchanged when it is within range", () => {
    expect(clamp(50, 0, 100)).toBe(50);
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 0, 100)).toBe(0); // at min boundary
    expect(clamp(100, 0, 100)).toBe(100); // at max boundary
  });
});

describe("formatResults()", () => {
  it("returns 'No results found.' for an empty array", () => {
    expect(formatResults([])).toBe("No results found.");
  });

  it("produces a count header when total is not provided", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const result = formatResults(rows);
    expect(result).toContain("2 result(s)");
    expect(result).toContain(JSON.stringify(rows, null, 2));
  });

  it("produces a range header when total exceeds row count", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const result = formatResults(rows, 100, 10, 2);
    expect(result).toContain("Showing 10\u201312 of 100");
    expect(result).toContain("(limit: 2)");
  });

  it("appends limit info when limit is provided", () => {
    const rows = [{ id: 1 }];
    const result = formatResults(rows, undefined, undefined, 50);
    expect(result).toContain("(limit: 50)");
  });
});

describe("constants", () => {
  it("DEFAULT_LIMIT is 50", () => {
    expect(DEFAULT_LIMIT).toBe(50);
  });

  it("MAX_LIMIT is 500", () => {
    expect(MAX_LIMIT).toBe(500);
  });
});
