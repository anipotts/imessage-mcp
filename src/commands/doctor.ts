// doctor — setup diagnostics for imessage-mcp
//
// Checks: macOS?, chat.db exists?, Full Disk Access?, message count,
// AddressBook contacts, Node version.

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const CHAT_DB = process.env.IMESSAGE_DB || path.join(homedir(), "Library/Messages/chat.db");

interface Check {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Platform check
  const os = platform();
  checks.push({
    name: "macOS",
    status: os === "darwin" ? "pass" : "fail",
    detail: os === "darwin" ? `Running on macOS (${os})` : `Not macOS — got "${os}". iMessage is only available on macOS.`,
  });

  // 2. Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1));
  checks.push({
    name: "Node.js",
    status: major >= 18 ? "pass" : "fail",
    detail: major >= 18
      ? `Node ${nodeVersion} (>= 18 required)`
      : `Node ${nodeVersion} is too old — upgrade to Node 18+`,
  });

  // 3. chat.db exists
  const dbExists = existsSync(CHAT_DB);
  checks.push({
    name: "chat.db",
    status: dbExists ? "pass" : "fail",
    detail: dbExists
      ? `Found at ${CHAT_DB}`
      : `Not found at ${CHAT_DB}. Make sure Messages.app has been used on this Mac.`,
  });

  // 4. Full Disk Access (try to open the db)
  if (dbExists) {
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");

      // 5. Message count
      const row = db.prepare("SELECT COUNT(*) as count FROM message").get() as any;
      const count = row?.count ?? 0;
      checks.push({
        name: "Full Disk Access",
        status: "pass",
        detail: "Database readable — Full Disk Access is granted",
      });
      checks.push({
        name: "Messages",
        status: count > 0 ? "pass" : "warn",
        detail: count > 0
          ? `${count.toLocaleString()} messages indexed`
          : "Database is empty — no messages found",
      });

      db.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isFDA = message.includes("SQLITE_CANTOPEN") || message.includes("authorization denied");
      checks.push({
        name: "Full Disk Access",
        status: "fail",
        detail: isFDA
          ? "Cannot read chat.db — grant Full Disk Access to your terminal:\n  System Settings → Privacy & Security → Full Disk Access → enable your terminal app"
          : `Database error: ${message}`,
      });
    }
  }

  // 6. AddressBook
  const { getAddressBookSources, loadAddressBook } = await import("../contacts.js");
  const sources = getAddressBookSources();
  if (sources.length > 0) {
    const contacts = loadAddressBook();
    checks.push({
      name: "AddressBook",
      status: contacts.size > 0 ? "pass" : "warn",
      detail: contacts.size > 0
        ? `${contacts.size} contacts resolved from macOS AddressBook`
        : "AddressBook databases found but no contacts loaded",
    });
  } else {
    checks.push({
      name: "AddressBook",
      status: "warn",
      detail: "No AddressBook databases found — contact names won't be resolved. This is optional.",
    });
  }

  return checks;
}

// Run and display
const checks = await runChecks();
const allPassed = checks.every((c) => c.status !== "fail");

// --json flag for machine-readable output
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ checks, all_passed: allPassed }, null, 2));
  if (!allPassed) process.exit(1);
} else {
  const SYMBOLS = { pass: "\u2713", fail: "\u2717", warn: "!" };
  const COLORS = { pass: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m" };
  const RESET = "\x1b[0m";

  console.log("\nimessage-mcp doctor\n");

  for (const check of checks) {
    const sym = SYMBOLS[check.status];
    const color = COLORS[check.status];
    console.log(`  ${color}${sym}${RESET} ${check.name}: ${check.detail}`);
  }

  console.log("");
  if (allPassed) {
    console.log("All checks passed — ready to use!");
    console.log("");
    console.log("Quick setup:");
    console.log("");
    console.log("  claude mcp add imessage -- npx -y imessage-mcp");
    console.log("");
    console.log("Or add to your client's JSON config:");
    console.log("");
    console.log(`  {`);
    console.log(`    "mcpServers": {`);
    console.log(`      "imessage": {`);
    console.log(`        "command": "npx",`);
    console.log(`        "args": ["-y", "imessage-mcp"]`);
    console.log(`      }`);
    console.log(`    }`);
    console.log(`  }`);
    console.log("");
  } else {
    console.log("Some checks failed — fix the issues above and run again.\n");
    process.exit(1);
  }
}
