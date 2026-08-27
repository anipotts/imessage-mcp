import { describe, expect, it } from "vitest";
import { ImessageMcpError } from "../src/errors.js";
import { effectivePrivacy } from "../src/privacy.js";
import { errorResult, successResult } from "../src/result.js";

const maskingKey = Buffer.alloc(32, 7);

const privateData = {
  conversations: [{
    conversation_ref: "im2_secret",
    display_name: "Alice Example",
    participants: [{ name: "Alice Example", handle: "+15551234567" }],
    service_families: ["imessage"],
    kind: "direct",
    text: "private body",
    snippet: "private snippet",
    filename: "private.png",
    path: "/Users/real/Library/Messages/private.png",
    timestamp: "2026-08-10T12:34:56.000Z",
    edit: { timestamps: ["2026-08-10T12:35:56.000Z"] },
    reactions: [{ type: "emoji", emoji: "private-custom-reaction" }],
    current_state: { reaction_type: 2007, reaction_emoji: "private-sync-reaction" },
    attachments: [{ name: "private-alias.png", transfer_name: "private-transfer.png" }],
  }],
};

describe("privacy ceilings", () => {
  it("rejects an unknown runtime privacy value before any projection", () => {
    expect(() => effectivePrivacy("full", "unsafe" as "full"))
      .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
  });

  it("keeps full fields only in full mode", () => {
    const result = successResult({ tool: "list_conversations", privacy: "full", maskingKey, effectiveScope: {}, data: privateData });
    expect(JSON.stringify(result.structuredContent)).toContain("private body");
    expect(JSON.stringify(result.structuredContent)).toContain("+15551234567");
    expect(JSON.stringify(result.structuredContent)).toContain("private-custom-reaction");
    expect(JSON.stringify(result.structuredContent)).toContain("private-sync-reaction");
  });

  it("keeps names, masks handles, reduces timestamps, and removes content in redacted mode", () => {
    const result = successResult({ tool: "list_conversations", privacy: "redacted", maskingKey, effectiveScope: {}, data: privateData });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("Alice Example");
    expect(serialized).toContain("[masked:");
    expect(serialized).toContain("2026-08-10");
    expect(serialized).not.toContain("12:34:56");
    expect(serialized).not.toContain("private body");
    expect(serialized).not.toContain("private.png");
    expect(serialized).not.toContain("private-alias.png");
    expect(serialized).not.toContain("private-transfer.png");
    expect(serialized).not.toContain("private-custom-reaction");
    expect(serialized).not.toContain("private-sync-reaction");
    expect(serialized).not.toContain("/Users/real");
    expect(serialized).toContain("2026-08-10");
    expect(serialized).not.toContain("12:35:56");
    expect(result.content[0]).not.toHaveProperty("text", expect.stringContaining("Alice"));
  });

  it("returns identity-free counts without opaque record references in aggregate mode", () => {
    const result = successResult({ tool: "list_conversations", privacy: "aggregate", maskingKey, effectiveScope: { privacy_mode: "aggregate" }, data: privateData });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("conversation_count");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("1555");
    expect(serialized).not.toContain("im2_secret");
    expect(serialized).not.toContain("private");
  });

  it("summarizes empty results with an explicit zero count", () => {
    const result = successResult({
      tool: "list_conversations",
      privacy: "aggregate",
      maskingKey,
      effectiveScope: { privacy_mode: "aggregate" },
      data: { conversations: [] },
    });
    expect(result.content).toEqual([{ type: "text", text: "list_conversations: complete; count=0" }]);
  });

  it("keeps stateless traversal cursors in aggregate mode without record references", () => {
    const result = successResult({
      tool: "sync_messages",
      privacy: "aggregate",
      maskingKey,
      effectiveScope: { privacy_mode: "aggregate" },
      data: {
        changes: [{ change_type: "message_created", service_family: "sms", message_ref: "im2_record" }],
        cursor: "im2_sync_cursor",
      },
      page: { next_cursor: "im2_sync_cursor", has_more: true, as_of: "watermark" },
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("im2_sync_cursor");
    expect(serialized).not.toContain("im2_record");
  });

  it("collapses ambiguous-contact error details without names or handles", () => {
    const result = errorResult(
      "resolve_contact",
      new ImessageMcpError("AMBIGUOUS_CONTACT", "contact query matched multiple unified contacts", {
        candidates: [
          { name: "Alice Private", handles: ["+15551234567"] },
          { name: "Alice Other", handles: ["alice@example.test"] },
        ],
      }),
      "redacted",
      maskingKey,
    );
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain('"match_count":2');
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("1555");
    expect(serialized).not.toContain("example.test");
  });
});
