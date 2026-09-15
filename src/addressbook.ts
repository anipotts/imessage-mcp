// Reads contact names, phone numbers and email addresses from the databases
// Contacts.app keeps under ~/Library/Application Support/AddressBook, one per
// account. Full Disk Access, which the server already needs for Messages,
// covers these files, and Contacts.framework is never called. Contacts that
// Contacts.app links across accounts (ZLINKID) are merged into one person.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeContact } from "./contacts.js";

const MAX_CONTACTS = 50_000;
const MAX_HANDLES_PER_CONTACT = 256;
const MAX_VALUE_CHARS = 4_096;

export function addressBookFiles(root = path.join(homedir(), "Library/Application Support/AddressBook")): string[] {
  const files = [path.join(root, "AddressBook-v22.abcddb")];
  const sources = path.join(root, "Sources");
  try {
    for (const source of readdirSync(sources)) files.push(path.join(sources, source, "AddressBook-v22.abcddb"));
  } catch {
    // no per-account sources
  }
  return files.filter((file) => existsSync(file));
}

function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > MAX_VALUE_CHARS ? "" : trimmed;
}

export type AddressBookResult =
  | { status: "ok"; contacts: NativeContact[] }
  | { status: "unavailable"; reason: string };

export function readAddressBook(files = addressBookFiles()): AddressBookResult {
  if (files.length === 0) return { status: "unavailable", reason: "contacts_not_found" };
  const people = new Map<string, NativeContact & { handles: Set<string> }>();
  let readable = 0;
  for (const file of files) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code === 23 || code === 14) continue;
      continue;
    }
    try {
      const entity = db.prepare("SELECT Z_ENT AS id FROM Z_PRIMARYKEY WHERE Z_NAME = 'ABCDContact'").get() as { id: number } | undefined;
      if (!entity) continue;
      readable += 1;
      const records = db.prepare(
        `SELECT Z_PK AS pk, ZUNIQUEID AS uid, ZLINKID AS link, ZTITLE AS title, ZFIRSTNAME AS first, ZMIDDLENAME AS middle,
                ZLASTNAME AS last, ZSUFFIX AS suffix, ZORGANIZATION AS organization, ZNICKNAME AS nickname
         FROM ZABCDRECORD WHERE Z_ENT = ?`,
      ).all(entity.id) as Array<Record<string, unknown>>;
      const phones = db.prepare("SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all() as Array<{ owner: number; value: unknown }>;
      const emails = db.prepare("SELECT ZOWNER AS owner, ZADDRESS AS value FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all() as Array<{ owner: number; value: unknown }>;
      const handlesByOwner = new Map<number, { phones: string[]; emails: string[] }>();
      for (const [rows, kind] of [[phones, "phones"], [emails, "emails"]] as const) {
        for (const row of rows) {
          const value = clean(row.value);
          if (!value) continue;
          const entry = handlesByOwner.get(row.owner) ?? { phones: [], emails: [] };
          entry[kind].push(value);
          handlesByOwner.set(row.owner, entry);
        }
      }
      for (const record of records) {
        const fullName = [record.first, record.middle, record.last, record.suffix].map(clean).filter(Boolean).join(" ");
        const name = fullName || clean(record.organization) || clean(record.nickname);
        const handles = handlesByOwner.get(record.pk as number) ?? { phones: [], emails: [] };
        const key = clean(record.link) || `${file}\0${String(record.pk)}`;
        const existing = people.get(key);
        if (existing) {
          if (!existing.name && name) existing.name = name;
          for (const phone of handles.phones) if (!existing.handles.has(phone)) { existing.handles.add(phone); existing.phones.push(phone); }
          for (const email of handles.emails) if (!existing.handles.has(email)) { existing.handles.add(email); existing.emails.push(email); }
        } else {
          people.set(key, {
            identifier: clean(record.uid) || key,
            name,
            phones: [...new Set(handles.phones)],
            emails: [...new Set(handles.emails)],
            handles: new Set([...handles.phones, ...handles.emails]),
          });
        }
        if (people.size > MAX_CONTACTS) return { status: "unavailable", reason: "contact_limit_exceeded" };
      }
    } catch {
      continue;
    } finally {
      db.close();
    }
  }
  if (readable === 0) return { status: "unavailable", reason: "contacts_unreadable" };
  const contacts: NativeContact[] = [];
  for (const person of people.values()) {
    if (person.phones.length + person.emails.length > MAX_HANDLES_PER_CONTACT) continue;
    contacts.push({ identifier: person.identifier, name: person.name, phones: person.phones, emails: person.emails });
  }
  return { status: "ok", contacts };
}
