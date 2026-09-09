#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { appleNanoseconds, createFixture, foundationAttributedBody } from "../tests/fixture.js";

// Every displayed value comes from a newly installed package and task-owned data.
// The GIF is a readable transcript of SDK calls, not a recording of a named app.
const scratch = mkdtempSync(path.join(tmpdir(), "imessage-installed-demo-"));
const fixture = createFixture();
const frames: string[] = [];
const transcript: string[] = [];
let client: Client | undefined;
try {
  const db = new Database(fixture.databasePath);
  try {
    db.exec("DELETE FROM chat_message_join; DELETE FROM message_attachment_join; DELETE FROM message;");
    const date = appleNanoseconds("2026-08-01T19:00:00Z");
    db.prepare("INSERT INTO message(ROWID,guid,attributedBody,handle_id,date,is_from_me,service) VALUES (1,?,?,?,?,0,'iMessage')")
      .run("synthetic-demo-1", foundationAttributedBody("Dinner reservation at 7. Meet outside."), 1, date);
    db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date) VALUES (1,1,?)").run(date);
  } finally {
    db.close();
  }
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], { encoding: "utf8" }));
  const install = path.join(scratch, "install");
  mkdirSync(install);
  writeFileSync(path.join(install, "package.json"), JSON.stringify({ private: true }));
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", path.join(scratch, packed.filename)], {
    cwd: install, stdio: "pipe",
  });
  const binary = path.join(install, "node_modules", ".bin", "imessage-mcp");
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("IMESSAGE_"),
  ));
  for (const [name, file] of [["IMESSAGE_REFERENCE_KEY_FILE", "reference-key"], ["IMESSAGE_DATABASE_ID_FILE", "database-id"]]) {
    env[name] = path.join(scratch, file);
    writeFileSync(env[name], `synthetic-demo-${file}-`.padEnd(48, "x"), { mode: 0o600 });
  }
  const args = ["--database", fixture.databasePath, "--contacts", "none"];
  const doctor = JSON.parse(execFileSync("npx", ["--no-install", "imessage-mcp", "doctor", ...args, "--privacy", "redacted", "--json"], {
    cwd: install, env, encoding: "utf8",
  }));
  assert.equal(doctor.status, "pass");
  const capture = (...lines: string[]) => {
    transcript.push(...lines);
    const textFile = path.join(scratch, `frame-${frames.length}.txt`);
    const frame = path.join(scratch, `frame-${frames.length}.png`);
    writeFileSync(textFile, transcript.join("\n"));
    execFileSync("magick", [
      "-size", "1080x480", "xc:#14191f", "-font", "/System/Library/Fonts/SFNSMono.ttf",
      "-pointsize", "22", "-fill", "#e2e8ed", "-gravity", "NorthWest",
      "-annotate", "+32+28", `@${textFile}`, frame,
    ]);
    frames.push(frame);
  };
  capture(`imessage-mcp ${version}`, "Fresh local package install | synthetic Messages data", "",
    "> npx --no-install imessage-mcp doctor [synthetic database]",
    `  ${doctor.status.toUpperCase()} - ${doctor.checks.filter((check: { status: string }) => check.status === "pass").length} diagnostic checks`, "");
  client = new Client({ name: "installed-demo", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: binary, args: [...args, "--privacy", "full"], cwd: install, env, stderr: "pipe" }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  capture("> MCP tools/list", `  ${tools.length} tools, all read-only`, "");
  const full = await client.callTool({ name: "search_messages", arguments: { query: "reservation", privacy_mode: "full" } });
  assert.ok(!full.isError);
  const fullData = (full.structuredContent as { data: { total_matches: number; results: Array<{ snippet: string }> } }).data;
  assert.equal(fullData.total_matches, 1);
  assert.equal(fullData.results[0].snippet, "Dinner reservation at 7. Meet outside.");
  capture('> MCP search_messages: "reservation", privacy=full', `  ${fullData.total_matches} match`, `  ${fullData.results[0].snippet}`, "");
  const aggregate = await client.callTool({ name: "search_messages", arguments: { query: "reservation", privacy_mode: "aggregate" } });
  assert.ok(!aggregate.isError);
  const aggregateData = (aggregate.structuredContent as { data: { total_matches: number } }).data;
  assert.equal(aggregateData.total_matches, 1);
  assert.doesNotMatch(JSON.stringify(aggregate), /Dinner|Meet outside|1555/u);
  capture('> MCP search_messages: "reservation", privacy=aggregate', `  ${aggregateData.total_matches} match; no message text or identities returned`);
  execFileSync("magick", ["-delay", "400", ...frames, "-loop", "0", "-layers", "Optimize", "assets/demo.gif"]);
  const digest = createHash("sha256").update(readFileSync("assets/demo.gif")).digest("hex");
  writeFileSync("assets/manifest.json", JSON.stringify({
    schema_version: 2, subject_version: version, channel: version.includes("-") ? "next" : "latest",
    assets: [{ path: "assets/demo.gif", sha256: digest, width: 1080, height: 480 }],
  }, null, 2) + "\n");
  writeFileSync("docs/DEMO.md", `# Installed demo\n\n![Installed imessage-mcp demo with synthetic data](../assets/demo.gif)\n\n` +
    `Recorded on ${new Date().toISOString().slice(0, 10)} using Node ${process.version}. The script packs the checkout, installs that tarball into an empty project, runs doctor through npx, and calls the installed server through the MCP SDK. All Messages data is synthetic. The GIF renders the captured responses; it does not show a named client app or a clean Mac installation. Paths are abbreviated.\n\n` +
    `Reproduce on a supported Mac with Node and ImageMagick installed:\n\n\`\`\`sh\nnpm ci\nnpm run demo:installed\n\`\`\`\n\n` +
    `Captured transcript:\n\n\`\`\`text\n${transcript.join("\n")}\n\`\`\`\n`);
  process.stdout.write(`installed demo passed for ${version}; wrote assets/demo.gif and docs/DEMO.md\n`);
} finally {
  await client?.close();
  fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true });
}
