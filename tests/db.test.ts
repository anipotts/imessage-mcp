import { describe, it, expect } from "vitest";
import {
  repliedToCondition,
  baseMessageConditions,
  DATE_EXPR,
  APPLE_EPOCH_OFFSET,
  extractTextFromAttributedBody,
  getMessageText,
} from "../src/db.js";

describe("repliedToCondition()", () => {
  it("returns a SQL string containing is_from_me", () => {
    const sql = repliedToCondition();
    expect(typeof sql).toBe("string");
    expect(sql).toContain("is_from_me");
  });

  it("references the handle table for subquery filtering", () => {
    const sql = repliedToCondition();
    expect(sql).toContain("handle");
    expect(sql).toContain("SELECT DISTINCT");
  });
});

describe("baseMessageConditions()", () => {
  it("returns an array of SQL condition strings", () => {
    const conditions = baseMessageConditions();
    expect(Array.isArray(conditions)).toBe(true);
    expect(conditions.length).toBeGreaterThanOrEqual(3);
  });

  it("includes the text/attributedBody null check", () => {
    const conditions = baseMessageConditions();
    const joined = conditions.join(" ");
    expect(joined).toContain("m.text IS NOT NULL OR m.attributedBody IS NOT NULL");
  });

  it("includes the tapback filter", () => {
    const conditions = baseMessageConditions();
    const joined = conditions.join(" ");
    expect(joined).toContain("m.associated_message_type = 0");
  });
});

describe("DATE_EXPR", () => {
  it("is a non-empty string containing the Apple epoch offset", () => {
    expect(typeof DATE_EXPR).toBe("string");
    expect(DATE_EXPR.length).toBeGreaterThan(0);
    expect(DATE_EXPR).toContain(String(APPLE_EPOCH_OFFSET));
  });

  it("is a valid SQL datetime expression", () => {
    expect(DATE_EXPR).toContain("datetime(");
    expect(DATE_EXPR).toContain("unixepoch");
    expect(DATE_EXPR).toContain("localtime");
  });
});

describe("extractTextFromAttributedBody()", () => {
  it("returns null for an empty buffer", () => {
    expect(extractTextFromAttributedBody(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for a buffer of random bytes without NSString marker", () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(extractTextFromAttributedBody(garbage)).toBeNull();
  });

  it("returns null when passed null/undefined input", () => {
    expect(extractTextFromAttributedBody(null as any)).toBeNull();
    expect(extractTextFromAttributedBody(undefined as any)).toBeNull();
  });
});

describe("getMessageText()", () => {
  it("prefers the text column when it contains valid text", () => {
    const row = { text: "hello world", attributedBody: Buffer.from("fallback") };
    expect(getMessageText(row)).toBe("hello world");
  });

  it("falls back to attributedBody when text is null", () => {
    // attributedBody is garbage here, so extraction returns null
    const row = { text: null, attributedBody: Buffer.from([0x00, 0x01]) };
    expect(getMessageText(row)).toBeNull();
  });

  it("returns null when both text and attributedBody are absent", () => {
    const row = { text: null, attributedBody: null };
    expect(getMessageText(row)).toBeNull();
  });

  it("skips the object replacement character U+FFFC", () => {
    const row = { text: "\ufffc", attributedBody: null };
    expect(getMessageText(row)).toBeNull();
  });
});
