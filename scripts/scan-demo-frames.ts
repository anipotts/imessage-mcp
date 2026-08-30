#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MEDIA = [
  "imessage-mcp-demo.gif",
  "imessage-mcp-setup.mp4",
  "imessage-mcp-live-sync.mp4",
  "imessage-mcp-analytics.mp4",
] as const;
const PATTERNS = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  phone: /(?:^|\D)(?:\+?\d[\d ().-]{7,}\d)(?:\D|$)/u,
  absolute_path: /(?:\/(?:Users|home|private|Volumes)\/[^\s]+|[A-Z]:\\[^\s]+)/iu,
  handle: /(?:^|\s)@[A-Z0-9_]{2,}\b/iu,
  url: /(?:https?:\/\/|www\.)\S+/iu,
  secret_label: /\b(?:api[_ -]?key|access[_ -]?token|password|bearer|private key|ghp_|npm_)\b/iu,
  raw_database_value: /\b(?:chat\.db|conversation_ref|message_ref|ROWID|handle_id)\b/iu,
  notification_artifact: /\b(?:Notification Center|Do Not Disturb|Focus mode|new notification)\b/iu,
  desktop_artifact: /\b(?:Finder|Trash|Desktop Folder)\b/iu,
} as const;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function boundedMap<T>(values: T[], concurrency: number, work: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await work(values[index]);
    }
  }));
}

const [mediaDirectory, outputFile = "demo-automated-scan.json"] = process.argv.slice(2);
assert.ok(mediaDirectory, "usage: scan-demo-frames.ts <media-directory> [output-file]");
execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
execFileSync("tesseract", ["--version"], { stdio: "ignore" });

const result = [];
for (const name of MEDIA) {
  const source = path.join(mediaDirectory, name);
  const stat = lstatSync(source);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `${name} must be a regular media file`);
  const frameDirectory = mkdtempSync(path.join(tmpdir(), "imessage-demo-frames-"));
  const counts = Object.fromEntries(Object.keys(PATTERNS).map((key) => [key, 0])) as Record<string, number>;
  let frameCount = 0;
  try {
    execFileSync("ffmpeg", [
      "-v", "error",
      "-i", source,
      "-map", "0:v:0",
      "-vsync", "0",
      "-compression_level", "6",
      path.join(frameDirectory, "frame-%08d.png"),
    ], { stdio: "ignore", timeout: 15 * 60_000 });
    const frames = readdirSync(frameDirectory)
      .filter((entry) => /^frame-\d{8}\.png$/u.test(entry))
      .sort()
      .map((entry) => path.join(frameDirectory, entry));
    assert.ok(frames.length > 0, `${name} produced no decoded frames`);
    frameCount = frames.length;
    await boundedMap(frames, 8, async (frame) => {
      const { stdout } = await run("tesseract", [frame, "stdout", "-l", "eng", "--psm", "6"], {
        encoding: "utf8",
        maxBuffer: 512 * 1024,
        timeout: 30_000,
      });
      for (const [category, pattern] of Object.entries(PATTERNS)) {
        if (pattern.test(stdout)) counts[category] += 1;
      }
    });
  } finally {
    rmSync(frameDirectory, { recursive: true, force: true });
  }
  result.push({
    name,
    sha256: sha256(source),
    decoded_frames: frameCount,
    ocr_frames: frameCount,
    unresolved_pattern_frames: counts,
  });
}

for (const entry of result) {
  assert.ok(Object.values(entry.unresolved_pattern_frames).every((count) => count === 0),
    `${entry.name} contains unresolved sensitive-pattern frames`);
}
const receipt = {
  schema_version: 1,
  scanner: "ffmpeg-all-frames+tesseract-5",
  stores_recognized_text: false,
  media: result,
};
writeFileSync(outputFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`automated demo scan passed: ${result.reduce((sum, entry) => sum + entry.decoded_frames, 0)} frames reviewed with no unresolved patterns\n`);
