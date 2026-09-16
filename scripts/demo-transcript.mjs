#!/usr/bin/env node
// Drives the real, built server against a fictional demo database and
// prints each question and its actual answer, typewriter-paced for a
// terminal recording (see assets/demo.tape). Nothing here is canned:
// every line comes from a live doctor run or a live tool call, including
// the mid-recording message insert that sync_messages picks up.

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemoDatabase } from "./build-demo-database.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binPath = path.join(repoRoot, "bin", "imessage-mcp.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const type = async (line) => {
  process.stdout.write("$ ");
  for (const char of line) {
    process.stdout.write(char);
    await sleep(18);
  }
  process.stdout.write("\n");
  await sleep(300);
};
const say = async (line, delay = 550) => {
  process.stdout.write(`${line}\n`);
  await sleep(delay);
};

async function main() {
  const databasePath = buildDemoDatabase();

  await type("npx imessage-mcp doctor");
  const doctor = execFileSync(
    process.execPath,
    [binPath, "--database", databasePath, "--contacts", "none", "doctor"],
    { encoding: "utf8" },
  );
  for (const line of doctor.trim().split("\n").slice(0, 5)) await say(`  ${line}`, 250);
  await say("", 500);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, "--database", databasePath, "--contacts", "none"],
    cwd: repoRoot,
    env: { ...process.env, IMESSAGE_UPDATE_CHECK: "0", IMESSAGE_CACHE: "0" },
    stderr: "ignore",
  });
  const client = new Client({ name: "imessage-mcp-demo", version: "1.0.0" });
  await client.connect(transport);

  await type('search_messages "reservation"');
  const search = await client.callTool({
    name: "search_messages",
    arguments: { query: "reservation", scopes: ["text"], limit: 5 },
  });
  const searchData = search.structuredContent.data;
  await say(`  ${searchData.total_matches} match: "${searchData.results[0].snippet}"`, 900);

  await type('get_conversation "Book Club"');
  const conversation = await client.callTool({
    name: "get_conversation",
    arguments: { query: "Book Club", limit: 10 },
  });
  for (const event of conversation.structuredContent.data.events) {
    if (event.event_type !== "message") continue;
    const who = event.direction === "outgoing" ? "me" : "them";
    const edited = (event.edit?.timestamps?.length ?? 0) > 0 ? " (edited)" : "";
    await say(`  [${who}] ${event.text}${edited}`, 380);
  }

  await sleep(400);
  await type("sync_messages");
  const firstSync = await client.callTool({ name: "sync_messages", arguments: { limit: 20 } });
  const cursor = firstSync.structuredContent.data.cursor;
  await say(`  0 changes yet, cursor saved`, 700);

  // A message arrives while the cursor is open, exactly like a live Mac.
  const live = new DatabaseSync(databasePath);
  const at = (Date.parse("2026-09-15T09:00:00Z") - Date.parse("2001-01-01T00:00:00Z")) * 1_000_000;
  live.exec(`INSERT INTO message(ROWID, guid, text, handle_id, date, service) VALUES (9, 'd8', 'actually let''s do Saturday instead', 2, ${at}, 'iMessage')`);
  live.exec("INSERT INTO chat_message_join(chat_id, message_id, message_date) VALUES (2, 9, " + at + ")");
  live.close();

  await say("  (a new message arrives)", 900);
  await type("sync_messages --cursor <same cursor>");
  const nextSync = await client.callTool({ name: "sync_messages", arguments: { limit: 20, cursor } });
  const change = nextSync.structuredContent.data.changes[0];
  await say(`  1 change: message_created — "${change.text}"\n`, 1200);

  await client.close();
}

await main();
