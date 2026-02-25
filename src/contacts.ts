// Contact resolution -- macOS AddressBook auto-resolve
//
// No hardcoded contacts. Queries the local AddressBook SQLite databases
// to resolve phone numbers and emails to real names.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";

export type ContactTier = "known" | "unknown";

export interface Contact {
  id: string;
  name: string;
  tier: ContactTier;
}

// macOS AddressBook auto-resolve cache
// Loaded once on first lookup, maps normalized digits/emails -> name
let addressBookCache: Map<string, string> | null = null;

export function getAddressBookSources(): string[] {
  const sourcesDir = path.join(
    homedir(),
    "Library",
    "Application Support",
    "AddressBook",
    "Sources",
  );
  if (!existsSync(sourcesDir)) return [];

  try {
    const entries = readdirSync(sourcesDir);
    return entries
      .map((e) => path.join(sourcesDir, e, "AddressBook-v22.abcddb"))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

export function loadAddressBook(): Map<string, string> {
  const cache = new Map<string, string>();
  const sources = getAddressBookSources();

  // Load phone numbers
  for (const dbPath of sources) {
    try {
      const sql = `SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON r.Z_PK = p.ZOWNER WHERE p.ZFULLNUMBER IS NOT NULL`;
      const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      if (!raw) continue;

      const rows = JSON.parse(raw) as { ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZFULLNUMBER: string }[];
      for (const row of rows) {
        const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(" ").trim();
        if (!name) continue;

        // Store by normalized digits (last 10) for fuzzy matching
        const digits = row.ZFULLNUMBER.replace(/\D/g, "");
        if (digits.length >= 10) {
          cache.set(digits.slice(-10), name);
        }
        // Also store full number with + prefix
        if (row.ZFULLNUMBER.startsWith("+")) {
          cache.set(row.ZFULLNUMBER, name);
        }
      }
    } catch {
      // Skip unreadable sources
    }
  }

  // Load email addresses
  for (const dbPath of sources) {
    try {
      const sql = `SELECT r.ZFIRSTNAME, r.ZLASTNAME, e.ZADDRESS FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON r.Z_PK = e.ZOWNER WHERE e.ZADDRESS IS NOT NULL`;
      const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      if (!raw) continue;

      const rows = JSON.parse(raw) as { ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZADDRESS: string }[];
      for (const row of rows) {
        const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(" ").trim();
        if (!name) continue;
        cache.set(row.ZADDRESS.toLowerCase(), name);
      }
    } catch {
      // Skip
    }
  }

  return cache;
}

function resolveFromAddressBook(handle: string): string | null {
  if (addressBookCache === null) {
    addressBookCache = loadAddressBook();
  }

  // Try exact match (email or +number)
  const lower = handle.toLowerCase();
  if (addressBookCache.has(lower)) return addressBookCache.get(lower)!;
  if (addressBookCache.has(handle)) return addressBookCache.get(handle)!;

  // Try last-10-digits match
  const digits = handle.replace(/\D/g, "");
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    if (addressBookCache.has(last10)) return addressBookCache.get(last10)!;
  }

  return null;
}

/**
 * Look up a contact by handle (phone number, email).
 * Uses macOS AddressBook for resolution, falls back to raw handle.
 */
export function lookupContact(handle: string): Contact {
  const cleaned = handle.trim();

  // Resolve from macOS AddressBook
  const name = resolveFromAddressBook(cleaned);
  if (name) {
    return { id: cleaned, name, tier: "known" };
  }

  return { id: cleaned, name: cleaned, tier: "unknown" };
}
