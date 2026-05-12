import { describe, it, expect } from "vitest";
import { buildContactClause } from "../src/contact-filter.js";

describe("buildContactClause()", () => {
  it("returns no clause when contact is missing", () => {
    const out = buildContactClause({});
    expect(out.clause).toBeUndefined();
    expect(out.mode).toBeNull();
  });

  it("builds handle LIKE clause for explicit handle mode", () => {
    const out = buildContactClause({
      contact: "+15551234567",
      contact_mode: "handle",
      alias: "h.id",
      prefix: "c",
    });
    expect(out.mode).toBe("handle");
    expect(out.clause).toBe("h.id LIKE @c");
    expect(out.bindings.c).toContain("+15551234567");
  });

  it("auto mode detects numeric handles", () => {
    const out = buildContactClause({
      contact: "5551234567",
      alias: "h.id",
      prefix: "auto",
    });
    expect(out.mode).toBe("handle");
    expect(out.clause).toBe("h.id LIKE @auto");
  });
});

