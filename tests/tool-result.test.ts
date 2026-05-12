import { describe, it, expect, afterEach } from "vitest";
import { normalizeToolResult, normalizeToolError } from "../src/tool-result.js";

const origProfile = process.env.IMESSAGE_REDACTION_PROFILE;
const origSafe = process.env.IMESSAGE_SAFE_MODE;

afterEach(() => {
  if (origProfile === undefined) delete process.env.IMESSAGE_REDACTION_PROFILE;
  else process.env.IMESSAGE_REDACTION_PROFILE = origProfile;
  if (origSafe === undefined) delete process.env.IMESSAGE_SAFE_MODE;
  else process.env.IMESSAGE_SAFE_MODE = origSafe;
});

describe("normalizeToolResult()", () => {
  it("adds structuredContent envelope from JSON text payload", () => {
    const out = normalizeToolResult("sample_tool", {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });

    expect(out.structuredContent).toBeDefined();
    expect((out.structuredContent as any).tool).toBe("sample_tool");
    expect((out.structuredContent as any).data.ok).toBe(true);
  });

  it("redacts text fields when strict profile is enabled", () => {
    process.env.IMESSAGE_REDACTION_PROFILE = "strict";
    const out = normalizeToolResult("sample_tool", {
      content: [{ type: "text", text: JSON.stringify({ text: "hello", handle: "+15551234567" }) }],
    });

    const payload = (out.structuredContent as any).data;
    expect(payload.text).toContain("REDACTED");
    expect(payload.handle).toContain("REDACTED");
  });
});

describe("normalizeToolError()", () => {
  it("returns isError result with structured error payload", () => {
    const out = normalizeToolError("x", new Error("boom"));
    expect(out.isError).toBe(true);
    expect((out.structuredContent as any).error.code).toBe("TOOL_EXECUTION_ERROR");
  });
});

