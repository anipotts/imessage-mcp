// Contact resolution through macOS Contacts.framework.
//
// Contacts.framework performs Apple's linked-card and preferred-name resolution
// before records reach this process. Distinct unified contacts that share a
// handle remain distinct candidates and are never collapsed by scan order.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ContactTier = "known" | "unknown";

export interface Contact {
  id: string;
  name: string;
  tier: ContactTier;
}

export interface UnifiedContactRecord {
  identifier: string;
  name: string;
  phones: string[];
  emails: string[];
}

export interface ContactCandidate {
  name: string;
  handles: string[];
}

export type ContactResolution =
  | { status: "unique"; candidate: ContactCandidate }
  | { status: "ambiguous"; candidates: ContactCandidate[] }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

interface NativeContactSuccess {
  status: "ok";
  contacts: UnifiedContactRecord[];
}

interface NativeContactUnavailable {
  status: "unavailable";
  reason: string;
}

type NativeContactResult = NativeContactSuccess | NativeContactUnavailable;
type ContactLoader = () => NativeContactResult;

interface IndexedHandle {
  raw: string;
  key: string;
  searchKey: string;
}

interface IndexedContact {
  identifier: string;
  name: string;
  nameKey: string;
  handles: IndexedHandle[];
}

const CONTACT_RESOLVER_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../native/contact-resolver.js",
);
const MAX_NATIVE_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_CONTACTS = 50_000;

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeContactName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function normalizeContactHandle(value: string): { key: string; searchKey: string } | null {
  const cleaned = value.normalize("NFKC").trim();
  if (!cleaned) return null;

  if (cleaned.includes("@")) {
    const email = cleaned.toLocaleLowerCase("en-US");
    return { key: `email:${email}`, searchKey: email };
  }

  const digits = cleaned.replace(/\D/gu, "");
  if (digits.length > 0) {
    const canonicalDigits = digits.length >= 10 ? digits.slice(-10) : digits;
    return { key: `phone:${canonicalDigits}`, searchKey: canonicalDigits };
  }

  const other = cleaned.toLocaleLowerCase("en-US");
  return { key: `other:${other}`, searchKey: other };
}

function parseNativeResult(raw: string): NativeContactResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unavailable", reason: "invalid_native_response" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { status: "unavailable", reason: "invalid_native_response" };
  }

  const value = parsed as Record<string, unknown>;
  if (value.status === "unavailable") {
    return {
      status: "unavailable",
      reason: cleanString(value.reason) || "contacts_unavailable",
    };
  }
  if (value.status !== "ok" || !Array.isArray(value.contacts)) {
    return { status: "unavailable", reason: "invalid_native_response" };
  }
  if (value.contacts.length > MAX_NATIVE_CONTACTS) {
    return { status: "unavailable", reason: "contact_limit_exceeded" };
  }

  const contacts: UnifiedContactRecord[] = [];
  for (const candidate of value.contacts) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const identifier = cleanString(row.identifier);
    if (!identifier) continue;

    contacts.push({
      identifier,
      name: cleanString(row.name),
      phones: Array.isArray(row.phones)
        ? row.phones.map(cleanString).filter(Boolean)
        : [],
      emails: Array.isArray(row.emails)
        ? row.emails.map(cleanString).filter(Boolean)
        : [],
    });
  }

  return { status: "ok", contacts };
}

function loadNativeContacts(): NativeContactResult {
  if (process.platform !== "darwin" || !existsSync(CONTACT_RESOLVER_SCRIPT)) {
    return { status: "unavailable", reason: "contacts_unavailable" };
  }

  try {
    const raw = execFileSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", CONTACT_RESOLVER_SCRIPT],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseNativeResult(raw);
  } catch {
    return { status: "unavailable", reason: "contacts_query_failed" };
  }
}

function compareIndexedContacts(left: IndexedContact, right: IndexedContact): number {
  const byName = left.nameKey.localeCompare(right.nameKey, "en-US");
  if (byName !== 0) return byName;
  return left.identifier.localeCompare(right.identifier, "en-US");
}

function publicCandidate(contact: IndexedContact): ContactCandidate {
  return {
    name: contact.name,
    handles: contact.handles.map((handle) => handle.raw),
  };
}

export class UnifiedContactResolver {
  private loaded = false;
  private unavailableReason: string | null = null;
  private contacts: IndexedContact[] = [];
  private byHandle = new Map<string, IndexedContact[]>();

  constructor(private readonly loader: ContactLoader = loadNativeContacts) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    const result = this.loader();
    if (result.status === "unavailable") {
      this.unavailableReason = result.reason;
      return;
    }

    const byIdentifier = new Map<string, IndexedContact>();
    for (const record of result.contacts) {
      const handlesByKey = new Map<string, IndexedHandle>();
      for (const raw of [...record.phones, ...record.emails]) {
        const normalized = normalizeContactHandle(raw);
        if (!normalized || handlesByKey.has(normalized.key)) continue;
        handlesByKey.set(normalized.key, { raw, ...normalized });
      }
      if (handlesByKey.size === 0) continue;

      const indexed: IndexedContact = {
        identifier: record.identifier,
        name: record.name,
        nameKey: normalizeContactName(record.name),
        handles: [...handlesByKey.values()].sort((left, right) =>
          left.key.localeCompare(right.key, "en-US")
        ),
      };
      byIdentifier.set(record.identifier, indexed);
    }

    this.contacts = [...byIdentifier.values()].sort(compareIndexedContacts);
    for (const contact of this.contacts) {
      for (const handle of contact.handles) {
        const candidates = this.byHandle.get(handle.key) ?? [];
        candidates.push(contact);
        candidates.sort(compareIndexedContacts);
        this.byHandle.set(handle.key, candidates);
      }
    }
  }

  status(): { available: boolean; contactCount: number; reason?: string } {
    this.ensureLoaded();
    return this.unavailableReason
      ? { available: false, contactCount: 0, reason: this.unavailableReason }
      : { available: true, contactCount: this.contacts.length };
  }

  lookup(handle: string): Contact {
    const cleaned = handle.trim();
    if (!cleaned) return { id: "", name: "(unknown)", tier: "unknown" };

    const normalized = normalizeContactHandle(cleaned);
    if (!normalized) return { id: cleaned, name: cleaned, tier: "unknown" };

    this.ensureLoaded();
    const candidates = this.byHandle.get(normalized.key) ?? [];
    if (candidates.length === 1 && candidates[0].name) {
      return { id: cleaned, name: candidates[0].name, tier: "known" };
    }

    return { id: cleaned, name: cleaned, tier: "unknown" };
  }

  resolve(query: string): ContactResolution {
    const cleaned = query.trim();
    if (!cleaned) return { status: "not_found" };

    this.ensureLoaded();
    if (this.unavailableReason) {
      return { status: "unavailable", reason: this.unavailableReason };
    }

    const looksLikeHandle = cleaned.includes("@") || /\d/u.test(cleaned);
    let matches: IndexedContact[];
    if (looksLikeHandle) {
      const normalized = normalizeContactHandle(cleaned);
      matches = normalized ? [...(this.byHandle.get(normalized.key) ?? [])] : [];
    } else {
      const nameKey = normalizeContactName(cleaned);
      matches = nameKey
        ? this.contacts.filter((contact) => contact.nameKey.includes(nameKey))
        : [];
    }

    matches.sort(compareIndexedContacts);
    if (matches.length === 0) return { status: "not_found" };
    if (matches.length === 1) {
      return { status: "unique", candidate: publicCandidate(matches[0]) };
    }
    return { status: "ambiguous", candidates: matches.map(publicCandidate) };
  }

  handlesForName(name: string): string[] {
    const resolution = this.resolve(name);
    const candidates = resolution.status === "unique"
      ? [resolution.candidate]
      : resolution.status === "ambiguous"
        ? resolution.candidates
        : [];

    const keys = new Set<string>();
    for (const candidate of candidates) {
      for (const handle of candidate.handles) {
        const normalized = normalizeContactHandle(handle);
        if (normalized) keys.add(normalized.searchKey);
      }
    }
    return [...keys].sort((left, right) => left.localeCompare(right, "en-US"));
  }

  uniqueHandleMap(): Map<string, string> {
    this.ensureLoaded();
    const result = new Map<string, string>();
    for (const [key, candidates] of this.byHandle) {
      if (candidates.length === 1 && candidates[0].name) {
        result.set(key, candidates[0].name);
      }
    }
    return result;
  }
}

const resolver = new UnifiedContactResolver();

export function lookupContact(handle: string): Contact {
  return resolver.lookup(handle);
}

export function resolveByName(name: string): string[] {
  return resolver.handlesForName(name);
}

export function resolveContact(query: string): ContactResolution {
  return resolver.resolve(query);
}

export function getAddressBookStatus(): { available: boolean; contactCount: number; reason?: string } {
  return resolver.status();
}

export function loadAddressBook(): Map<string, string> {
  return resolver.uniqueHandleMap();
}
