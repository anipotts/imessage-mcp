import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ImessageMcpError } from "./errors.js";

export interface ContactCandidate {
  name: string | null;
  handles: string[];
  match: "exact_handle" | "exact_name" | "partial_name";
}

export type ContactResolution =
  | { status: "unique"; contact: ContactCandidate }
  | { status: "ambiguous"; candidates: ContactCandidate[] }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

export interface NativeContact {
  identifier: string;
  name: string;
  phones: string[];
  emails: string[];
}

interface IndexedContact extends NativeContact {
  nameKey: string;
  handleKeys: Map<string, string>;
}

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../native/contact-resolver.js");
const MAX_CONTACTS = 50_000;
const MAX_CONTACT_CANDIDATES = 20;
const MAX_HANDLES_PER_RESULT = 64;
const MAX_HANDLES_PER_CONTACT = 256;
const MAX_CONTACT_VALUE_BYTES = 4096;
const MAX_CONTACT_SOURCE_BYTES = 8 * 1024 * 1024;

function validContactValue(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_CONTACT_VALUE_BYTES;
}

function validateContactSource(source: unknown): source is NativeContact[] {
  if (!Array.isArray(source) || source.length > MAX_CONTACTS) return false;
  let bytes = 0;
  for (const contact of source) {
    if (!contact || typeof contact !== "object" || Array.isArray(contact)) return false;
    const value = contact as Record<string, unknown>;
    if (!validContactValue(value.identifier) || !validContactValue(value.name)) return false;
    if (!Array.isArray(value.phones) || !Array.isArray(value.emails) ||
        value.phones.length + value.emails.length > MAX_HANDLES_PER_CONTACT ||
        !value.phones.every(validContactValue) || !value.emails.every(validContactValue)) return false;
    bytes += Buffer.byteLength(value.identifier, "utf8") + Buffer.byteLength(value.name, "utf8");
    for (const handle of [...value.phones, ...value.emails] as string[]) bytes += Buffer.byteLength(handle, "utf8");
    if (bytes > MAX_CONTACT_SOURCE_BYTES) return false;
  }
  return true;
}

export function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function normalizeHandle(value: string): string {
  const cleaned = value.normalize("NFKC").trim();
  if (cleaned.includes("@")) return `email:${cleaned.toLocaleLowerCase("en-US")}`;
  const digits = cleaned.replace(/\D/gu, "");
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) {
    return `phone:us:${digits.slice(-10)}`;
  }
  if (digits) return `phone:${digits}`;
  return `other:${cleaned.toLocaleLowerCase("en-US")}`;
}

export function looksLikeHandle(value: string): boolean {
  const cleaned = value.normalize("NFKC").trim();
  if (/^\S+@\S+$/u.test(cleaned)) return true;
  return /^[+\d\s().-]+$/u.test(cleaned) && (cleaned.match(/\d/gu)?.length ?? 0) >= 3;
}

export class UnifiedContactResolver {
  private loaded = false;
  private unavailable: string | null = null;
  private contacts: IndexedContact[] = [];
  private byHandle = new Map<string, IndexedContact[]>();

  constructor(
    private readonly enabled: boolean,
    private readonly testContacts?: NativeContact[],
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.testContacts) {
      this.index(this.testContacts);
      return;
    }
    if (!this.enabled || process.platform !== "darwin" || !existsSync(SCRIPT)) {
      this.unavailable = "contacts_not_paired";
      return;
    }
    try {
      const raw = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", SCRIPT], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const result = JSON.parse(raw) as { status: string; reason?: string; contacts?: NativeContact[] };
      if (result.status !== "ok" || !validateContactSource(result.contacts)) {
        this.unavailable = result.reason ?? "contacts_unavailable";
        return;
      }
      this.index(result.contacts);
    } catch {
      this.unavailable = "contacts_query_failed";
    }
  }

  private index(source: NativeContact[]): void {
    if (!validateContactSource(source)) {
      this.unavailable = "contacts_budget_exceeded";
      return;
    }
    this.contacts = source.map((contact) => {
      const handleKeys = new Map<string, string>();
      for (const handle of [...contact.phones, ...contact.emails]) {
        const key = normalizeHandle(handle);
        if (!handleKeys.has(key)) handleKeys.set(key, handle);
      }
      return { ...contact, nameKey: normalizeName(contact.name), handleKeys };
    });
    this.contacts.sort((a, b) => a.nameKey.localeCompare(b.nameKey) || a.identifier.localeCompare(b.identifier));
    for (const contact of this.contacts) {
      for (const key of contact.handleKeys.keys()) {
        const candidates = this.byHandle.get(key) ?? [];
        candidates.push(contact);
        this.byHandle.set(key, candidates);
      }
    }
  }

  status(): { state: "available" | "unavailable"; count: number; reason?: string } {
    this.load();
    return this.unavailable
      ? { state: "unavailable", count: 0, reason: this.unavailable }
      : { state: "available", count: this.contacts.length };
  }

  nameForHandle(handle: string): string | null {
    this.load();
    const matches = this.byHandle.get(normalizeHandle(handle)) ?? [];
    return matches.length === 1 ? matches[0].name || null : null;
  }

  resolve(query: string): ContactResolution {
    this.load();
    if (this.unavailable) return { status: "unavailable", reason: this.unavailable };
    const cleaned = query.trim();
    if (!cleaned) return { status: "not_found" };
    const handleLike = looksLikeHandle(cleaned);
    let matches: Array<{ contact: IndexedContact; match: ContactCandidate["match"] }> = [];
    if (handleLike) {
      matches = (this.byHandle.get(normalizeHandle(cleaned)) ?? [])
        .slice(0, MAX_CONTACT_CANDIDATES + 1)
        .map((contact) => ({ contact, match: "exact_handle" }));
    } else {
      const key = normalizeName(cleaned);
      const exact: IndexedContact[] = [];
      for (const contact of this.contacts) {
        if (contact.nameKey === key) {
          exact.push(contact);
          if (exact.length > MAX_CONTACT_CANDIDATES) break;
        }
      }
      if (exact.length) {
        matches = exact.map((contact) => ({ contact, match: "exact_name" }));
      } else {
        if (key.length < 2) {
          throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "partial contact queries require at least two characters", {
            retry: "provide a longer name or an exact handle",
          });
        }
        for (const contact of this.contacts) {
          if (contact.nameKey.includes(key)) {
            matches.push({ contact, match: "partial_name" });
            if (matches.length > MAX_CONTACT_CANDIDATES) break;
          }
        }
      }
    }
    if (matches.length > MAX_CONTACT_CANDIDATES) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "contact query matched too many candidates", {
        match_count: matches.length,
        retry: "provide a more specific name or an exact handle",
      });
    }
    const candidates = matches.map(({ contact, match }) => {
      const handles = [...contact.handleKeys.values()].sort();
      if (handles.length > MAX_HANDLES_PER_RESULT) {
        throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "a contact has too many handles to return safely", {
          match_count: handles.length,
          retry: "query one exact phone number or email address",
        });
      }
      return { name: contact.name, handles, match };
    });
    if (candidates.length === 0) return { status: "not_found" };
    if (candidates.length === 1) return { status: "unique", contact: candidates[0] };
    return { status: "ambiguous", candidates };
  }
}
