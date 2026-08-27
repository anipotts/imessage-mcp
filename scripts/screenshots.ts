#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_DATABASE_PATH, runtimeConfig } from "../src/config.js";
import { LocalToolRuntime } from "../src/tool-local.js";
import { createFixture } from "../tests/fixture.js";

const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const releaseChannel = packageVersion.includes("-") ? "next" : "latest";

const suppliedDatabase = process.argv.find((value) => value.startsWith("--database="))?.slice("--database=".length) ?? process.env.IMESSAGE_DB;
if (suppliedDatabase && path.resolve(suppliedDatabase) === path.resolve(DEFAULT_DATABASE_PATH)) {
  throw new Error("screenshot generation refuses the live default Messages database");
}
if (suppliedDatabase) {
  throw new Error("screenshot generation accepts only its generated synthetic database");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function terminalSvg(lines: string[], theme: "light" | "dark", title: string): string {
  const dark = theme === "dark";
  const page = dark ? "#101218" : "#f5f7fb";
  const panel = dark ? "#191d27" : "#ffffff";
  const bar = dark ? "#232938" : "#e9edf5";
  const text = dark ? "#e5e9f3" : "#202634";
  const muted = dark ? "#8b95aa" : "#687386";
  const height = Math.max(500, 132 + lines.length * 25);
  const rendered = lines.map((line, index) => {
    const y = 98 + index * 25;
    const color = line.startsWith("pass ") || line.startsWith("›") || line.startsWith("$")
      ? (dark ? "#78dba9" : "#18794e")
      : line.startsWith("meta ")
        ? muted
        : text;
    const value = line.startsWith("meta ") ? line.slice(5) : line;
    return `<text x="52" y="${y}" fill="${color}">${escapeXml(value)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="940" height="${height}" viewBox="0 0 940 ${height}">
    <rect width="940" height="${height}" fill="${page}"/>
    <rect x="28" y="28" width="884" height="${height - 56}" rx="15" fill="${panel}"/>
    <path d="M43 28h854a15 15 0 0 1 15 15v33H28V43a15 15 0 0 1 15-15z" fill="${bar}"/>
    <circle cx="50" cy="52" r="6" fill="#ff6b6b"/>
    <circle cx="70" cy="52" r="6" fill="#f5c451"/>
    <circle cx="90" cy="52" r="6" fill="#62c98d"/>
    <text x="112" y="57" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12">${escapeXml(title)}</text>
    <g font-family="SFMono-Regular, Menlo, monospace" font-size="14">${rendered}</g>
  </svg>`;
}

function pngRecord(selectedPath: string): { path: string; sha256: string; width: number; height: number } {
  const bytes = readFileSync(selectedPath);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${selectedPath} is not a PNG`);
  return {
    path: selectedPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function main(): Promise<void> {
  const fixture = createFixture();
  const runtime = new LocalToolRuntime(
    runtimeConfig({
      transport: "stdio",
      databasePath: fixture.databasePath,
      contacts: "none",
      referenceKey: Buffer.alloc(32, 0x5a),
      databaseId: Buffer.alloc(32, 0x6b),
      privacy: "redacted",
    }),
    Buffer.alloc(32, 9),
  );
  const scratch = mkdtempSync(path.join(tmpdir(), "imessage-mcp-screenshots-"));
  try {
    const status = await runtime.call("server_status", { privacy_mode: "redacted" });
    const listed = await runtime.call("list_conversations", { limit: 50, privacy_mode: "redacted" });
    const statusData = (status.structuredContent?.data ?? {}) as Record<string, unknown>;
    const listedData = (listed.structuredContent?.data ?? {}) as { conversations?: Array<Record<string, unknown>> };
    const conversations = listedData.conversations ?? [];
    const services = Array.isArray(statusData.detected_services)
      ? statusData.detected_services.join(", ")
      : "imessage, rcs, sms, unknown";
    const conversationLines = conversations.map((conversation) => {
      const families = Array.isArray(conversation.service_families)
        ? conversation.service_families.map(String).join(" + ")
        : "unknown";
      const kind = conversation.kind === "group" ? "synthetic group" : "synthetic direct chat";
      const label = typeof conversation.display_name === "string" && conversation.display_name
        ? conversation.display_name.toLowerCase()
        : kind;
      const count = Number(conversation.message_count ?? 0);
      return `  ${label.padEnd(25)} ${families.padEnd(19)} ${count} message${count === 1 ? "" : "s"}`;
    });
    const demo = [
      "› list my conversations by service",
      "",
      `imessage-mcp: complete; count=${conversations.length}`,
      "",
      ...conversationLines,
      "",
      `meta services detected: ${services}`,
      "meta source: synthetic-chat.db · privacy: redacted · read-only",
    ];
    const doctor = [
      "$ imessage-mcp doctor --contacts none --privacy redacted",
      "",
      "imessage-mcp doctor: pass",
      "pass platform: macOS 14 or newer",
      "pass node: supported active release",
      "pass database_read: synthetic chat.db is readable",
      "pass wal_read: no active WAL is present",
      "pass schema: supported Mac Messages fixture",
      "pass decoder: Foundation self-test passed",
      "pass package: metadata versions match",
      "",
      "meta database: /Users/example/Library/Messages/synthetic-chat.db",
      "meta no settings or files were changed",
    ];

    mkdirSync("assets", { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      for (const [name, lines, title] of [
        ["demo", demo, "synthetic imessage-mcp session"],
        ["doctor", doctor, "synthetic read-only diagnostics"],
      ] as const) {
        const source = path.join(scratch, `${name}-${theme}.svg`);
        writeFileSync(source, terminalSvg([...lines], theme, title));
        execFileSync("rsvg-convert", [
          "--format", "png",
          "--width", "1880",
          "--output", `assets/${name}-${theme}.png`,
          source,
        ], { stdio: "ignore" });
        process.stdout.write(`generated assets/${name}-${theme}.png\n`);
      }
    }
    const assetPaths = [
      "assets/demo-dark.png",
      "assets/demo-light.png",
      "assets/doctor-dark.png",
      "assets/doctor-light.png",
      "assets/logo.png",
    ];
    writeFileSync("assets/manifest.json", `${JSON.stringify({
      schema_version: 2,
      subject_version: packageVersion,
      channel: releaseChannel,
      assets: assetPaths.map(pngRecord),
    }, null, 2)}\n`);
  } finally {
    runtime.close();
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
