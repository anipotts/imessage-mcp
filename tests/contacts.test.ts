import { describe, expect, it, vi } from "vitest";
import {
  UnifiedContactResolver,
  normalizeContactHandle,
  normalizeContactName,
  type UnifiedContactRecord,
} from "../src/contacts.js";

const CONTACTS: UnifiedContactRecord[] = [
  {
    identifier: "linked-contact",
    name: "Jamie Rivera",
    phones: ["+1 (555) 555-0100"],
    emails: ["Jamie@Example.com"],
  },
  {
    identifier: "stale-secondary-card",
    name: "Pat Lee",
    phones: ["+15555550143"],
    emails: [],
  },
  {
    identifier: "current-primary-card",
    name: "Sam Diaz",
    phones: ["+1 (555) 555-0143"],
    emails: [],
  },
];

function resolver(records: UnifiedContactRecord[] = CONTACTS): UnifiedContactResolver {
  return new UnifiedContactResolver(() => ({ status: "ok", contacts: records }));
}

describe("contact normalization", () => {
  it("normalizes formatted and E.164-style US numbers once", () => {
    expect(normalizeContactHandle("+1 (555) 555-0143")).toEqual(
      normalizeContactHandle("+15555550143"),
    );
  });

  it("normalizes email casing and contact-name whitespace", () => {
    expect(normalizeContactHandle(" Jamie@Example.COM ")).toEqual({
      key: "email:jamie@example.com",
      searchKey: "jamie@example.com",
    });
    expect(normalizeContactName("  Jamie   Rivera ")).toBe("jamie rivera");
  });
});

describe("UnifiedContactResolver", () => {
  it("uses one Apple-unified record for all of its linked handles", () => {
    const contacts = resolver();

    expect(contacts.lookup("5555550100")).toMatchObject({
      name: "Jamie Rivera",
      tier: "known",
    });
    expect(contacts.lookup("jamie@example.com")).toMatchObject({
      name: "Jamie Rivera",
      tier: "known",
    });
    expect(contacts.resolve("Jamie Rivera")).toEqual({
      status: "unique",
      candidate: {
        name: "Jamie Rivera",
        handles: ["Jamie@Example.com", "+1 (555) 555-0100"],
      },
    });
  });

  it("never labels a shared normalized phone as either conflicting card", () => {
    const contacts = resolver();

    expect(contacts.lookup("+15555550143")).toEqual({
      id: "+15555550143",
      name: "+15555550143",
      tier: "unknown",
    });
    expect(contacts.resolve("+15555550143")).toEqual({
      status: "ambiguous",
      candidates: [
        { name: "Pat Lee", handles: ["+15555550143"] },
        { name: "Sam Diaz", handles: ["+1 (555) 555-0143"] },
      ],
    });
  });

  it("orders candidates deterministically regardless of native enumeration order", () => {
    const forward = resolver(CONTACTS).resolve("5555550143");
    const reverse = resolver([...CONTACTS].reverse()).resolve("5555550143");
    expect(reverse).toEqual(forward);
  });

  it("returns normalized SQL search keys for a resolved name", () => {
    expect(resolver().handlesForName("Jamie")).toEqual([
      "5555550100",
      "jamie@example.com",
    ]);
  });

  it("rejects an empty name instead of matching the entire address book", () => {
    const contacts = resolver();
    expect(contacts.resolve("   ")).toEqual({ status: "not_found" });
    expect(contacts.handlesForName("   ")).toEqual([]);
  });

  it("loads unified contacts once per server process", () => {
    const loader = vi.fn(() => ({ status: "ok" as const, contacts: CONTACTS }));
    const contacts = new UnifiedContactResolver(loader);

    contacts.lookup("5555550100");
    contacts.resolve("Jamie");
    contacts.status();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Contacts is unavailable", () => {
    const contacts = new UnifiedContactResolver(() => ({
      status: "unavailable",
      reason: "permission_denied",
    }));

    expect(contacts.lookup("5555550100").tier).toBe("unknown");
    expect(contacts.resolve("Jamie")).toEqual({
      status: "unavailable",
      reason: "permission_denied",
    });
  });
});
