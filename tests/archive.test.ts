import { describe, expect, it } from "vitest";
import { decodeBody, decodeEditHistory, parseBinaryPlist } from "../src/archive.js";
import {
  foundationAttributedBody,
  foundationAttributedBodyFromStdin,
  foundationAttributedBodyWithRuns,
  foundationEditSummary,
  foundationEmptyAttributedBody,
  foundationKeyedAttributedBody,
  foundationSummaryWithoutEdits,
} from "./fixture.js";

// Every archive below is produced by Foundation itself, so each assertion is a
// parity check between the pure decoder and Apple's own encoder.
describe("attributed bodies", () => {
  it.each([
    ["plain ascii", "hello there"],
    ["emoji and newlines", "blob exact ✨\nsecond line 👨‍👩‍👧‍👦"],
    ["right-to-left and combining marks", "مرحبا café é"],
  ])("decodes a typedstream body: %s", (_label, text) => {
    expect(decodeBody(foundationAttributedBody(text))).toEqual({ status: "decoded", text });
  });

  it("decodes a body with several attribute runs", () => {
    const text = "rich text across several runs 👨‍👩‍👧‍👦";
    expect(decodeBody(foundationAttributedBodyWithRuns(text))).toEqual({ status: "decoded", text });
  });

  it.each([true, false])("decodes an empty archived string (mutable %s)", (mutable) => {
    expect(decodeBody(foundationEmptyAttributedBody(mutable))).toEqual({ status: "decoded", text: "" });
  });

  it("decodes a body above one mebibyte", () => {
    const text = "long pasted message ".repeat(60_000);
    expect(decodeBody(foundationAttributedBodyFromStdin(text))).toEqual({ status: "decoded", text });
  });

  it.each([true, false])("decodes a keyed archive (mutable %s)", (mutable) => {
    expect(decodeBody(foundationKeyedAttributedBody("keyed body ✨", mutable))).toEqual({ status: "decoded", text: "keyed body ✨" });
  });

  it("reports truncated and foreign data as malformed", () => {
    const body = foundationAttributedBody("truncate me");
    for (const cut of [0, 1, 12, 24, body.length - 4]) {
      expect(decodeBody(body.subarray(0, cut))).toEqual({ status: "malformed" });
    }
    expect(decodeBody(Buffer.from("not an archive"))).toEqual({ status: "malformed" });
  });

  it("refuses bodies above the 4 MiB bound without reading them", () => {
    expect(decodeBody(Buffer.alloc(4 * 1024 * 1024 + 1))).toEqual({ status: "unsupported" });
  });
});

describe("edit history", () => {
  it("returns every edit after the original, sorted and unique", () => {
    expect(decodeEditHistory(foundationEditSummary([794_721_900, 794_721_960, 794_721_990]))).toEqual({
      status: "decoded",
      count: 2,
      timestamps: [794_721_960, 794_721_990],
    });
  });

  it("reads a summary without an edit collection as no edits", () => {
    expect(decodeEditHistory(foundationSummaryWithoutEdits())).toEqual({ status: "decoded", count: 0, timestamps: [] });
  });

  it("reports damaged summaries as malformed", () => {
    const summary = foundationEditSummary([794_721_900, 794_721_960]);
    expect(decodeEditHistory(summary.subarray(0, summary.length - 10))).toEqual({ status: "malformed" });
    expect(decodeEditHistory(Buffer.from("bplist00"))).toEqual({ status: "malformed" });
  });
});

describe("binary plist bounds", () => {
  it("rejects cyclic references", () => {
    // An array (0xa1) whose single element refers back to itself.
    const objects = Buffer.from([0xa1, 0x00]);
    const offsets = Buffer.from([0x08]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1;
    trailer[7] = 1;
    trailer.writeBigUInt64BE(1n, 8);
    trailer.writeBigUInt64BE(0n, 16);
    trailer.writeBigUInt64BE(BigInt(8 + objects.length), 24);
    const plist = Buffer.concat([Buffer.from("bplist00"), objects, offsets, trailer]);
    expect(() => parseBinaryPlist(plist)).toThrow();
  });
});
