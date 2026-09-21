#!/usr/bin/env node
// Records the README demo against the real Messages database on this Mac:
// real message text, real contact names, readable times. Phone numbers and
// email addresses are starred out everywhere, including inside message text.
// Nothing here writes to the Messages database.
//
//   DEMO_QUERY="dinner" npm run demo
//
// The query picks the story: the newest match, the conversation around it,
// and how fast each side replies in that chat. Review assets/demo.gif frame
// by frame before committing it; it shows whatever that conversation holds.

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const query = process.env.DEMO_QUERY;
if (!query) {
  process.stderr.write('set DEMO_QUERY, for example DEMO_QUERY="dinner" npm run demo\n');
  process.exit(1);
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binPath = path.join(repoRoot, "bin", "imessage-mcp.js");

const PHONE = /\+?\d[\d\s().-]{6,}\d/gu;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const starDigits = (value) => value.replace(/\d(?=(?:\D*\d){2})/gu, "*");
const scrub = (value) => String(value ?? "").replace(EMAIL, (m) => `${m[0]}***@***`).replace(PHONE, starDigits);
const who = (sender, direction) => direction === "outgoing" ? "me" : scrub(sender?.name?.split(" ")[0] ?? sender?.handle ?? "?");
const when = (iso) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clip = (value, max = 64) => { const text = scrub(value).replace(/\s+/gu, " ").trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const minutes = (seconds) => seconds == null ? "n/a" : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} hr`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const type = async (line) => {
  process.stdout.write("\x1b[36m›\x1b[0m ");
  for (const char of line) { process.stdout.write(char); await sleep(28); }
  process.stdout.write("\n");
  await sleep(350);
};
const say = async (line, delay = 450) => { process.stdout.write(`${line}\n`); await sleep(delay); };
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: repoRoot,
    env: { ...process.env, IMESSAGE_UPDATE_CHECK: "0" },
    stderr: "ignore",
  });
  const client = new Client({ name: "imessage-mcp-demo", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
    return result.structuredContent.data;
  };

  await say(dim("# ask your AI about your texts. read-only, runs on your Mac."), 900);

  await type(`find the message about "${query}"`);
  const search = await call("search_messages", { query, limit: 3 });
  const hit = search.results[0];
  if (!hit) throw new Error(`no match for ${query}`);
  await say(dim(`  search_messages · ${search.total_matches} matches, newest first`), 400);
  for (const result of search.results) {
    await say(`  ${dim(when(result.timestamp))}  ${who(result.sender, result.sender?.name === "Me" ? "outgoing" : "incoming")}: ${clip(result.snippet)}`, 350);
  }
  await sleep(700);

  await type("show me that conversation");
  const conversation = await call("get_conversation", { chat_id: hit.chat_id, around_message_id: hit.message_id, limit: 7, event_types: ["message"] });
  await say(dim("  get_conversation · around that message"), 400);
  for (const event of conversation.events) {
    const edited = (event.edit?.timestamps?.length ?? 0) > 0 ? dim(" (edited)") : "";
    const reactions = event.reactions?.length ? ` ${event.reactions.map((r) => r.emoji ?? r.type).join("")}` : "";
    await say(`  ${dim(when(event.timestamp))}  ${who(event.sender, event.direction)}: ${clip(event.text)}${edited}${reactions}`, 330);
  }
  await sleep(700);

  await type("who replies faster in that chat?");
  const speed = await call("analyze_communication", { metric: "response_time", scope: "conversation", chat_id: hit.chat_id });
  await say(dim("  analyze_communication · response_time"), 400);
  await say(`  you reply in ~${minutes(speed.overall.my_average_seconds)}, they reply in ~${minutes(speed.overall.their_average_seconds)}`, 700);
  await say(dim(`  across ${speed.overall.samples} back-and-forths`), 1600);

  await client.close();
}

await main();
