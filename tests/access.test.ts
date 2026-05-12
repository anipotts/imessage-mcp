import { describe, it, expect } from "vitest";
import { withRequestContext } from "../src/context.js";
import { checkToolAccess } from "../src/access.js";

describe("checkToolAccess()", () => {
  it("allows local context with no principal", () => {
    const result = withRequestContext(
      {
        principal: null,
        profile_id: "default",
        db_path: "/tmp/chat.db",
      },
      () => checkToolAccess("export_evidence_bundle"),
    );

    expect(result.ok).toBe(true);
  });

  it("denies tool calls when scopes are missing", () => {
    const result = withRequestContext(
      {
        principal: {
          auth_mode: "oauth2",
          subject: "alice",
          client_id: "client-a",
          scopes: ["messages.read"],
          allowed_profiles: ["default"],
        },
        profile_id: "default",
        db_path: "/tmp/chat.db",
      },
      () => checkToolAccess("export_evidence_bundle"),
    );

    expect(result.ok).toBe(false);
    expect(result.missing_scopes).toContain("export.read");
  });

  it("supports wildcard scopes", () => {
    const result = withRequestContext(
      {
        principal: {
          auth_mode: "oauth2",
          subject: "bob",
          client_id: "client-b",
          scopes: ["analytics.*"],
          allowed_profiles: ["default"],
        },
        profile_id: "default",
        db_path: "/tmp/chat.db",
      },
      () => checkToolAccess("needs_reply"),
    );

    expect(result.ok).toBe(true);
  });
});
