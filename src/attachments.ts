// Turns one row of the attachment table into content an MCP tool can return.
// The file named in that row was chosen by whoever sent the message, so every
// step here is defensive: the path is resolved and confined to the real
// Attachments directory, size and pixel counts are capped before any bytes
// are decoded, images are re-encoded through sips rather than parsed in
// process, and the metadata sips itself can embed (EXIF GPS, device info) is
// stripped from the JPEG we hand back. No PDF, audio or video parsing ships;
// unsupported types come back as metadata only.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const ATTACHMENT_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxMegapixels: 50,
  defaultLongEdge: 1600,
  maxTextBytes: 64 * 1024,
  sipsTimeoutMs: 10_000,
} as const;

export type AttachmentContent =
  | { kind: "image"; mimeType: "image/jpeg"; data: Buffer; width: number; height: number }
  | { kind: "text"; text: string; truncated: boolean }
  | {
      kind: "metadata";
      reason: "not_downloaded" | "outside_attachments" | "too_large" | "unsupported_type" | "image_too_large" | "conversion_failed" | "unreadable";
    };

export interface AttachmentRecord {
  filename: string | null;
  mime_type: string | null;
  uti: string | null;
  total_bytes: number | null;
}

export interface ReadAttachmentOptions {
  attachmentsRoot?: string;
  home?: string;
  tempRoot?: string;
  maxLongEdge?: number;
  sips?: string;
}

// UTIs Messages assigns to images whose mime_type row is missing or generic.
const IMAGE_UTIS = new Set([
  "public.heic",
  "public.heif",
  "public.jpeg",
  "public.png",
  "public.tiff",
  "com.compuserve.gif",
  "public.webp",
]);

// text/* subtypes that are really structured metadata, not prose to read back.
const TEXT_METADATA_MIME = new Set(["text/vcard", "text/x-vlocation"]);

function metadata(reason: Extract<AttachmentContent, { kind: "metadata" }>["reason"]): AttachmentContent {
  return { kind: "metadata", reason };
}

// Resolves "~" against the given home, matching how Messages stores paths in
// the filename column.
function expandHome(filename: string, home: string): string {
  if (filename === "~") return home;
  if (filename.startsWith("~/")) return path.join(home, filename.slice(2));
  return filename;
}

function isImage(mimeType: string | null, uti: string | null): boolean {
  if (mimeType && mimeType.startsWith("image/")) return true;
  if (uti && IMAGE_UTIS.has(uti)) return true;
  return false;
}

function isReadableText(mimeType: string | null): boolean {
  if (!mimeType || !mimeType.startsWith("text/")) return false;
  return !TEXT_METADATA_MIME.has(mimeType);
}

// Runs sips with no shell, a hard timeout and a kill signal on timeout.
// Resolves with stdout on a clean exit; rejects on any non-zero exit,
// timeout, or spawn failure so callers can uniformly report a failure.
function runSips(sips: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      sips,
      args,
      { timeout: ATTACHMENT_LIMITS.sipsTimeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// Parses the two "-g pixelWidth -g pixelHeight" lines sips prints, e.g.
//   pixelWidth: 1600
//   pixelHeight: 1200
function parseDimensions(sipsOutput: string): { width: number; height: number } | null {
  const width = /pixelWidth:\s*(\d+)/.exec(sipsOutput);
  const height = /pixelHeight:\s*(\d+)/.exec(sipsOutput);
  if (!width || !height) return null;
  return { width: Number(width[1]), height: Number(height[1]) };
}

// Walks JPEG segments from the SOI marker, dropping every APPn (0xFFE0-0xFFEF)
// and COM (0xFFFE) segment so no EXIF/XMP/ICC/IPTC metadata survives. Copies
// everything else verbatim and stops re-parsing at SOS, appending the
// remaining scan data (and trailing EOI) unchanged. Throws on malformed input
// (missing SOI, or a segment length that runs past the buffer) rather than
// guessing, since a truncated or hostile file should never be reported as
// successfully cleaned.
export function stripJpegMetadata(jpeg: Buffer): Buffer {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("not a JPEG: missing SOI marker");
  }
  const chunks: Buffer[] = [jpeg.subarray(0, 2)];
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) throw new Error(`malformed JPEG: expected marker at offset ${offset}`);
    // Skip any fill bytes (0xFF) before the real marker byte.
    let markerOffset = offset;
    while (markerOffset < jpeg.length && jpeg[markerOffset] === 0xff) markerOffset += 1;
    if (markerOffset >= jpeg.length) throw new Error("malformed JPEG: truncated marker");
    const marker = 0xff00 | jpeg[markerOffset];
    const segmentStart = markerOffset - 1; // include the 0xFF byte
    if (marker === 0xffd9) {
      // EOI with nothing after (shouldn't normally happen before SOS, but
      // handle it defensively): copy through and stop.
      chunks.push(jpeg.subarray(segmentStart, segmentStart + 2));
      offset = segmentStart + 2;
      continue;
    }
    if (marker === 0xffda) {
      // Start of Scan: copy everything from here to the end verbatim.
      chunks.push(jpeg.subarray(segmentStart));
      offset = jpeg.length;
      break;
    }
    // Markers with no payload length (RSTn, TEM) - copy the 2 bytes and move on.
    if ((marker >= 0xffd0 && marker <= 0xffd7) || marker === 0xff01) {
      chunks.push(jpeg.subarray(segmentStart, segmentStart + 2));
      offset = segmentStart + 2;
      continue;
    }
    if (segmentStart + 4 > jpeg.length) throw new Error("malformed JPEG: truncated segment length");
    const length = jpeg.readUInt16BE(segmentStart + 2);
    const segmentEnd = segmentStart + 2 + length;
    if (length < 2 || segmentEnd > jpeg.length) throw new Error("malformed JPEG: segment length runs past buffer");
    const isApp = marker >= 0xffe0 && marker <= 0xffef;
    const isCom = marker === 0xfffe;
    if (!isApp && !isCom) chunks.push(jpeg.subarray(segmentStart, segmentEnd));
    offset = segmentEnd;
  }
  return Buffer.concat(chunks);
}

export async function readAttachmentContent(
  record: AttachmentRecord,
  options: ReadAttachmentOptions = {},
): Promise<AttachmentContent> {
  const home = options.home ?? homedir();
  const attachmentsRoot = options.attachmentsRoot ?? path.join(home, "Library/Messages/Attachments");
  const sips = options.sips ?? "/usr/bin/sips";

  if (!record.filename) return metadata("not_downloaded");
  const resolvedPath = expandHome(record.filename, home);

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(attachmentsRoot);
  } catch {
    return metadata("outside_attachments");
  }
  try {
    realFile = await realpath(resolvedPath);
  } catch {
    return metadata("not_downloaded");
  }

  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return metadata("outside_attachments");
  }

  let fileStat;
  try {
    fileStat = await stat(realFile);
  } catch {
    return metadata("not_downloaded");
  }
  if (!fileStat.isFile()) return metadata("unreadable");
  if (fileStat.size > ATTACHMENT_LIMITS.maxFileBytes) return metadata("too_large");

  if (isImage(record.mime_type, record.uti)) {
    return readImage(realFile, sips, options);
  }
  if (isReadableText(record.mime_type)) {
    return readText(realFile, fileStat.size);
  }
  return metadata("unsupported_type");
}

async function readText(file: string, sizeBytes: number): Promise<AttachmentContent> {
  try {
    const handle = await readFile(file);
    const truncated = sizeBytes > ATTACHMENT_LIMITS.maxTextBytes;
    const slice = truncated ? handle.subarray(0, ATTACHMENT_LIMITS.maxTextBytes) : handle;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return { kind: "text", text, truncated };
  } catch {
    return metadata("unreadable");
  }
}

async function readImage(file: string, sips: string, options: ReadAttachmentOptions): Promise<AttachmentContent> {
  let dimensions: { width: number; height: number } | null;
  try {
    const output = await runSips(sips, ["-g", "pixelWidth", "-g", "pixelHeight", file]);
    dimensions = parseDimensions(output);
  } catch {
    return metadata("conversion_failed");
  }
  if (!dimensions) return metadata("conversion_failed");
  const megapixels = (dimensions.width * dimensions.height) / 1_000_000;
  if (megapixels > ATTACHMENT_LIMITS.maxMegapixels) return metadata("image_too_large");

  const edge = Math.min(ATTACHMENT_LIMITS.defaultLongEdge, options.maxLongEdge ?? ATTACHMENT_LIMITS.defaultLongEdge);
  const tempParent = options.tempRoot ?? tmpdir();
  let tempDir: string | undefined;
  try {
    // mkdtemp always creates the directory with 0700 permissions (mode is not
    // a supported option; the OS enforces this regardless of the umask).
    tempDir = await mkdtemp(path.join(tempParent, "imessage-mcp-att-"));
  } catch {
    return metadata("conversion_failed");
  }
  try {
    const outFile = path.join(tempDir, `${randomBytes(8).toString("hex")}.jpg`);
    try {
      await runSips(sips, ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(edge), file, "--out", outFile]);
    } catch {
      return metadata("conversion_failed");
    }
    let converted: Buffer;
    try {
      converted = await readFile(outFile);
    } catch {
      return metadata("conversion_failed");
    }
    let stripped: Buffer;
    try {
      stripped = stripJpegMetadata(converted);
    } catch {
      return metadata("conversion_failed");
    }
    let finalDims: { width: number; height: number } | null;
    try {
      const finalOutput = await runSips(sips, ["-g", "pixelWidth", "-g", "pixelHeight", outFile]);
      finalDims = parseDimensions(finalOutput);
    } catch {
      return metadata("conversion_failed");
    }
    if (!finalDims) return metadata("conversion_failed");
    return { kind: "image", mimeType: "image/jpeg", data: stripped, width: finalDims.width, height: finalDims.height };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
