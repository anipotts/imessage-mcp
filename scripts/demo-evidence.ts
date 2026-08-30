#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_GIF_BYTES = 9_500_000;
const MAX_VIDEO_BYTES = 10_000_000;

interface ReviewReceipt {
  schema_version: 1;
  consent_verified: true;
  bounded_history_review: true;
  automated_sensitive_scan: true;
  manual_frame_review: true;
  first_name_only: true;
  no_raw_identifiers: true;
  no_unrelated_conversations: true;
  no_secrets_or_paths: true;
  no_audio: true;
}

interface AutomatedScanReceipt {
  schema_version: 1;
  scanner: "ffmpeg-all-frames+tesseract-5";
  stores_recognized_text: false;
  media: Array<{
    name: string;
    sha256: string;
    decoded_frames: number;
    ocr_frames: number;
    unresolved_pattern_frames: Record<string, number>;
  }>;
}

interface Stream {
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
}

interface Probe {
  streams?: Stream[];
  format?: { duration?: string; format_name?: string; size?: string };
}

interface MediaExpectation {
  name: string;
  kind: "hero" | "setup" | "live_sync" | "analytics";
  container: "gif" | "mp4";
  width: number;
  height: number;
  maximumBytes: number;
  minimumSeconds: number;
  maximumSeconds: number;
}

const EXPECTED: MediaExpectation[] = [
  {
    name: "imessage-mcp-demo.gif",
    kind: "hero",
    container: "gif",
    width: 1280,
    height: 800,
    maximumBytes: MAX_GIF_BYTES,
    minimumSeconds: 10,
    maximumSeconds: 35,
  },
  {
    name: "imessage-mcp-setup.mp4",
    kind: "setup",
    container: "mp4",
    width: 1440,
    height: 900,
    maximumBytes: MAX_VIDEO_BYTES,
    minimumSeconds: 20,
    maximumSeconds: 90,
  },
  {
    name: "imessage-mcp-live-sync.mp4",
    kind: "live_sync",
    container: "mp4",
    width: 1440,
    height: 900,
    maximumBytes: MAX_VIDEO_BYTES,
    minimumSeconds: 10,
    maximumSeconds: 60,
  },
  {
    name: "imessage-mcp-analytics.mp4",
    kind: "analytics",
    container: "mp4",
    width: 1440,
    height: 900,
    maximumBytes: MAX_VIDEO_BYTES,
    minimumSeconds: 10,
    maximumSeconds: 60,
  },
];

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function rate(value: string | undefined): number {
  assert.ok(value && /^\d+\/\d+$/u.test(value), "media frame rate is missing");
  const [numerator, denominator] = value.split("/").map(Number);
  assert.ok(denominator > 0);
  return numerator / denominator;
}

function inspect(directory: string, expected: MediaExpectation) {
  const file = path.join(directory, expected.name);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${expected.name} must be a regular file`);
  assert.ok(stat.size > 0 && stat.size < expected.maximumBytes,
    `${expected.name} exceeds its publication size ceiling`);
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 })) as Probe;
  const streams = probe.streams ?? [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  assert.equal(videos.length, 1, `${expected.name} must contain one video stream`);
  assert.equal(audio.length, 0, `${expected.name} must contain no audio`);
  const video = videos[0];
  assert.deepEqual({ width: video.width, height: video.height }, {
    width: expected.width,
    height: expected.height,
  });
  const framesPerSecond = rate(video.avg_frame_rate);
  if (expected.container === "gif") {
    assert.equal(video.codec_name, "gif");
    assert.ok(framesPerSecond >= 10 && framesPerSecond <= 15,
      "hero GIF must remain between 10 and 15 frames per second");
  } else {
    assert.equal(video.codec_name, "h264");
    assert.equal(video.pix_fmt, "yuv420p");
    assert.ok(framesPerSecond >= 29.9 && framesPerSecond <= 30.1,
      `${expected.name} must remain at 30 frames per second`);
  }
  const durationSeconds = Number(probe.format?.duration);
  assert.ok(Number.isFinite(durationSeconds) &&
    durationSeconds >= expected.minimumSeconds && durationSeconds <= expected.maximumSeconds,
  `${expected.name} duration is outside its reviewed range`);
  return {
    name: expected.name,
    kind: expected.kind,
    sha256: sha256(file),
    bytes: stat.size,
    width: expected.width,
    height: expected.height,
    duration_seconds: Number(durationSeconds.toFixed(3)),
    frames_per_second: Number(framesPerSecond.toFixed(3)),
    codec: video.codec_name,
    pixel_format: video.pix_fmt ?? null,
    audio_streams: 0,
  };
}

function review(file: string): ReviewReceipt {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024,
    "review receipt must be a small regular file");
  const value = JSON.parse(readFileSync(file, "utf8")) as ReviewReceipt;
  assert.deepEqual(Object.keys(value).sort(), [
    "automated_sensitive_scan",
    "bounded_history_review",
    "consent_verified",
    "first_name_only",
    "manual_frame_review",
    "no_audio",
    "no_raw_identifiers",
    "no_secrets_or_paths",
    "no_unrelated_conversations",
    "schema_version",
  ]);
  assert.equal(value.schema_version, 1);
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "schema_version") assert.equal(entry, true, `${key} must be explicitly reviewed`);
  }
  return value;
}

function automatedScan(file: string, media: Array<{ name: string; sha256: string }>): AutomatedScanReceipt {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 128 * 1024,
    "automated scan receipt must be a small regular file");
  const value = JSON.parse(readFileSync(file, "utf8")) as AutomatedScanReceipt;
  assert.equal(value.schema_version, 1);
  assert.equal(value.scanner, "ffmpeg-all-frames+tesseract-5");
  assert.equal(value.stores_recognized_text, false);
  assert.equal(value.media.length, media.length);
  for (const expected of media) {
    const entry = value.media.find((candidate) => candidate.name === expected.name);
    assert.ok(entry, `automated scan is missing ${expected.name}`);
    assert.equal(entry.sha256, expected.sha256, `${expected.name} scan hash does not match reviewed media`);
    assert.ok(Number.isInteger(entry.decoded_frames) && entry.decoded_frames > 0);
    assert.equal(entry.ocr_frames, entry.decoded_frames, `${expected.name} must OCR every decoded frame`);
    assert.ok(Object.keys(entry.unresolved_pattern_frames).length > 0);
    assert.ok(Object.values(entry.unresolved_pattern_frames).every((count) => count === 0),
      `${expected.name} has unresolved automated scan findings`);
  }
  return value;
}

const [mode, mediaDirectory, version, reviewFile, automatedScanFile, evidenceFile = "demo-evidence.json"] =
  process.argv.slice(2);
assert.ok(mode === "create" || mode === "verify",
  "usage: demo-evidence.ts create|verify <media-directory> <version> <review-receipt> <automated-scan> [evidence-file]");
assert.ok(mediaDirectory && version && reviewFile && automatedScanFile);
assert.match(version, /^\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$/u);
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
assert.equal(packageVersion.version, version, "demo evidence must name the current package version");
const media = EXPECTED.map((entry) => inspect(mediaDirectory, entry));
const evidence = {
  schema_version: 1,
  repository: "anipotts/imessage-mcp",
  subject_version: version,
  client: "Claude Code",
  terminal: "Ghostty",
  source: "live Apple Messages database",
  privacy_modes: ["full", "redacted"],
  release_assets_only: true,
  review: review(reviewFile),
  automated_scan: automatedScan(automatedScanFile, media),
  media,
};
if (mode === "create") {
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`created privacy-reviewed demo evidence for ${version}\n`);
} else {
  assert.deepEqual(JSON.parse(readFileSync(evidenceFile, "utf8")), evidence,
    "demo evidence does not match the reviewed media bytes");
  process.stdout.write(`verified privacy-reviewed demo evidence for ${version}\n`);
}
