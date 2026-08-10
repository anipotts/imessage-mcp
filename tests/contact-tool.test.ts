import { describe, expect, it } from "vitest";
import {
  contactAmbiguityResult,
  registerContactTools,
} from "../src/tools/contacts.js";

describe("resolve_contact compatibility hotfix", () => {
  it("returns a successful structured ambiguity result without selecting a name", () => {
    const result = contactAmbiguityResult("5555550143", [
      { name: "Pat Lee", handles: ["+15555550143"] },
      { name: "Sam Diaz", handles: ["+1 (555) 555-0143"] },
    ]);

    expect(result.structuredContent).toEqual({
      status: "ambiguous",
      query: "5555550143",
      candidates: [
        { candidate: 1, name: "Pat Lee", handles: ["+15555550143"] },
        { candidate: 2, name: "Sam Diaz", handles: ["+1 (555) 555-0143"] },
      ],
    });
    expect(result.content[0].text).toContain("no contact was guessed");
  });

  it("rejects an empty resolve_contact query before database access", () => {
    const registrations = new Map<string, any[]>();
    const server = {
      tool(name: string, ...args: any[]) {
        registrations.set(name, args);
      },
    };

    registerContactTools(server as any);
    const resolveRegistration = registrations.get("resolve_contact");
    expect(resolveRegistration).toBeDefined();
    const inputShape = resolveRegistration?.[1];
    expect(inputShape.query.safeParse("   ").success).toBe(false);
    expect(inputShape.query.safeParse("Sam Diaz").success).toBe(true);
  });
});
