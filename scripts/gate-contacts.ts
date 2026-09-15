// Gate G4: names from the direct AddressBook reader against the Contacts.framework
// resolver for every handle in chat.db. Read-only; counts only.
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedContactResolver } from "../src/contacts.js";
import { readAddressBook } from "../src/addressbook.js";
const chat = new DatabaseSync(path.join(os.homedir(), "Library/Messages/chat.db"), { readOnly: true });
const handles = (chat.prepare("SELECT DISTINCT id FROM handle").all() as Array<{ id: string }>).map((r) => r.id);
chat.close();
let started = performance.now();
const framework = new UnifiedContactResolver(true);
const frameworkStatus = framework.status();
const frameworkMs = performance.now() - started;
started = performance.now();
const direct = readAddressBook();
const directMs = performance.now() - started;
if (direct.status !== "ok") { console.log(JSON.stringify({ direct })); process.exit(1); }
const resolver = new UnifiedContactResolver(true, direct.contacts);
const tally: Record<string, number> = { handles: handles.length };
for (const handle of handles) {
  const a = framework.nameForHandle(handle);
  const b = resolver.nameForHandle(handle);
  const key = a === b ? (a ? "same_name" : "both_unnamed") : a && b ? "different_name" : a ? "framework_only" : "direct_only";
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(JSON.stringify({ framework: frameworkStatus, framework_ms: Math.round(frameworkMs), direct_contacts: direct.contacts.length, direct_ms: Math.round(directMs), tally }));
