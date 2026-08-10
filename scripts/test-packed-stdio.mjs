import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

const ISSUE_TEXT = "Hey Jordan, can you call me back at 555-0173 when you get a chance? Wanted to talk through the weekend plans before I book anything.";
const ISSUE_BLOB_BASE64 = "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4GEAEhleSBKb3JkYW4sIGNhbiB5b3UgY2FsbCBtZSBiYWNrIGF0IDU1NS0wMTczIHdoZW4geW91IGdldCBhIGNoYW5jZT8gV2FudGVkIHRvIHRhbGsgdGhyb3VnaCB0aGUgd2Vla2VuZCBwbGFucyBiZWZvcmUgSSBib29rIGFueXRoaW5nLoaEAmlJAYGEAJKEhIQMTlNEaWN0aW9uYXJ5AJSEAWkAhoY=";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function createSyntheticDatabase(databasePath) {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      display_name TEXT,
      chat_identifier TEXT NOT NULL
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      text TEXT,
      attributedBody BLOB,
      is_from_me INTEGER NOT NULL,
      date INTEGER NOT NULL,
      handle_id INTEGER,
      associated_message_type INTEGER NOT NULL DEFAULT 0,
      cache_has_attachments INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL);
    CREATE TABLE chat_handle_join (chat_id INTEGER NOT NULL, handle_id INTEGER NOT NULL);
  `);
  database.prepare("INSERT INTO handle (ROWID, id) VALUES (1, ?)").run("+15555550100");
  database.prepare("INSERT INTO chat (ROWID, display_name, chat_identifier) VALUES (1, NULL, ?)").run("synthetic-chat");
  database.prepare(`
    INSERT INTO message (
      ROWID, text, attributedBody, is_from_me, date, handle_id,
      associated_message_type, cache_has_attachments
    ) VALUES (1, NULL, ?, 0, 1, 1, 0, 0)
  `).run(Buffer.from(ISSUE_BLOB_BASE64, "base64"));
  database.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)").run();
  database.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)").run();
  database.close();
}

function textContent(result) {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "imessage-mcp-1.3.1-"));
let client;

try {
  const projectRoot = resolve(scriptDirectory, "..");
  const expectedPackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  let packageSpec = process.env.IMESSAGE_PACKAGE_SPEC;
  if (!packageSpec) {
    const packOutput = JSON.parse(execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot],
      { cwd: projectRoot, encoding: "utf8" },
    ));
    packageSpec = join(temporaryRoot, packOutput[0].filename);
  }
  const installRoot = join(temporaryRoot, "install");
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--prefix", installRoot, packageSpec],
    { stdio: "ignore" },
  );

  const installedPackage = JSON.parse(readFileSync(
    join(installRoot, "node_modules", "imessage-mcp", "package.json"),
    "utf8",
  ));
  if (installedPackage.version !== expectedPackage.version) {
    throw new Error(`expected package version ${expectedPackage.version}, received ${installedPackage.version}`);
  }

  const databasePath = join(temporaryRoot, "chat.db");
  createSyntheticDatabase(databasePath);

  const command = process.execPath;
  const serverEntry = join(
    installRoot,
    "node_modules",
    "imessage-mcp",
    "bin",
    "imessage-mcp.js",
  );
  const transport = new StdioClientTransport({
    command,
    args: [serverEntry],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      IMESSAGE_DB: databasePath,
    },
    stderr: "pipe",
  });
  client = new Client({ name: "packed-stdio-gate", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "search_messages")) {
    throw new Error("packed server did not expose search_messages");
  }

  const search = await client.callTool({
    name: "search_messages",
    arguments: {
      query: "weekend plans",
      include_all: true,
      limit: 10,
    },
  });
  const searchText = textContent(search);
  if (!searchText.includes(ISSUE_TEXT) || searchText.includes("�")) {
    throw new Error("packed stdio server did not return the complete attributed body");
  }

  let rejectedEmptyQuery = false;
  try {
    const emptyQuery = await client.callTool({
      name: "resolve_contact",
      arguments: { query: "   " },
    });
    rejectedEmptyQuery = emptyQuery.isError === true;
  } catch {
    rejectedEmptyQuery = true;
  }
  if (!rejectedEmptyQuery) {
    throw new Error("packed stdio server accepted an empty contact query");
  }

  console.log(JSON.stringify({
    status: "pass",
    source: process.env.IMESSAGE_PACKAGE_SPEC ? "registry" : "local_tarball",
    package_version: installedPackage.version,
    tools: tools.tools.length,
    attributed_body: "exact",
    empty_contact_query: "rejected",
  }));
} finally {
  if (client) await client.close().catch(() => undefined);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
