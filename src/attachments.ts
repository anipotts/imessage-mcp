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
import {
  chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { cacheDirectory } from "./cache.js";

export const ATTACHMENT_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxMegapixels: 50,
  defaultLongEdge: 1600,
  maxTextBytes: 64 * 1024,
  // The whole read (dimension probe plus conversion) shares one deadline;
  // this is that deadline's default length, not a per-call timeout.
  sipsTimeoutMs: 10_000,
} as const;

const TEMP_PREFIX = "att-";
const TEMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1000; // one hour

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
  // Overrides ATTACHMENT_LIMITS.sipsTimeoutMs for the whole read. Test-only
  // in practice (production callers rely on the default).
  timeoutMs?: number;
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

// SOF0 (baseline), SOF1 (extended sequential) and SOF2 (progressive): the
// only encodings sips's own JPEG output uses. Arithmetic-coded and
// hierarchical SOF variants are out of scope, matching what we ever produce.
const SOF_MARKERS = new Set([0xffc0, 0xffc1, 0xffc2]);

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

// A validated long-edge request: an integer of at least 1, else the default.
// A caller-supplied 0, a negative number, NaN or a fraction is never passed
// to sips; it silently falls back rather than producing a malformed -Z arg.
function validatedLongEdge(requested: number | undefined): number {
  if (typeof requested === "number" && Number.isInteger(requested) && requested >= 1) return requested;
  return ATTACHMENT_LIMITS.defaultLongEdge;
}

// Runs sips with no shell, a hard timeout and a kill signal on timeout. The
// timeout is derived from a shared per-attachment deadline (not a fresh
// window per call), so a slow probe leaves less time for the conversion
// rather than letting the two calls add up past ATTACHMENT_LIMITS.sipsTimeoutMs.
// Resolves with stdout on a clean exit; rejects on any non-zero exit,
// timeout, or spawn failure so callers can uniformly report a failure.
function runSips(sips: string, args: string[], deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = Math.max(1, deadline - Date.now());
    execFile(
      sips,
      args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
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

// Reads the image dimensions straight from a JPEG's SOF0/SOF1/SOF2 segment,
// so the caller never needs a third sips invocation just to learn the size
// of the file it already produced. Permissive on anything it doesn't
// recognize (returns null): stripJpegMetadata is the strict validator, this
// only ever runs on a buffer that already passed it.
function readJpegDimensions(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) return null;
    let markerOffset = offset;
    while (markerOffset < jpeg.length && jpeg[markerOffset] === 0xff) markerOffset += 1;
    if (markerOffset >= jpeg.length) return null;
    const marker = 0xff00 | jpeg[markerOffset];
    const segmentStart = markerOffset - 1;
    if (marker === 0xffd9 || marker === 0xffda) return null; // EOI/SOS before any SOF
    if ((marker >= 0xffd0 && marker <= 0xffd7) || marker === 0xff01) {
      offset = segmentStart + 2;
      continue;
    }
    if (segmentStart + 4 > jpeg.length) return null;
    const length = jpeg.readUInt16BE(segmentStart + 2);
    const segmentEnd = segmentStart + 2 + length;
    if (length < 2 || segmentEnd > jpeg.length) return null;
    if (SOF_MARKERS.has(marker) && segmentStart + 9 <= jpeg.length) {
      const height = jpeg.readUInt16BE(segmentStart + 5);
      const width = jpeg.readUInt16BE(segmentStart + 7);
      if (height > 0 && width > 0) return { width, height };
    }
    offset = segmentEnd;
  }
  return null;
}

// Walks JPEG segments from the SOI marker, dropping every APPn (0xFFE0-0xFFEF)
// and COM (0xFFFE) segment so no EXIF/XMP/ICC/IPTC metadata survives. Copies
// everything else verbatim. Past the first SOS, entropy-coded scan data is
// scanned rather than blindly copied to the end of the buffer: FF00 stuffing
// and FFD0-FFD7 restart markers stay inside the scan, any other marker is
// treated as a segment under the same APPn/COM drop rule (a progressive
// JPEG's later scans each start with their own SOS, which resumes scanning),
// and the first EOI is kept but ends output immediately; bytes after it
// (MPF, a gain map, a second embedded JPEG appended by some encoders) are
// never copied. Throws on malformed input (missing SOI, or a segment length
// that runs past the buffer) rather than guessing, since a truncated or
// hostile file should never be reported as successfully cleaned.
export function stripJpegMetadata(jpeg: Buffer): Buffer {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("not a JPEG: missing SOI marker");
  }
  const chunks: Buffer[] = [jpeg.subarray(0, 2)];
  let offset = 2;
  let inScan = false;
  while (offset < jpeg.length) {
    if (inScan) {
      const scanStart = offset;
      while (offset < jpeg.length) {
        if (jpeg[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let markerOffset = offset;
        while (markerOffset < jpeg.length && jpeg[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= jpeg.length) {
          offset = markerOffset;
          break;
        }
        const next = jpeg[markerOffset];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          // A stuffed literal 0xFF byte, or a restart marker: both stay
          // inside the entropy-coded data, so keep scanning past them.
          offset = markerOffset + 1;
          continue;
        }
        // A real marker: stop copying scan data at the last fill byte
        // before it (matching the header parser's own convention below).
        offset = markerOffset - 1;
        break;
      }
      if (offset > scanStart) chunks.push(jpeg.subarray(scanStart, offset));
      if (offset >= jpeg.length) break; // truncated mid-scan: nothing more to add
      inScan = false;
      continue;
    }

    if (jpeg[offset] !== 0xff) throw new Error(`malformed JPEG: expected marker at offset ${offset}`);
    // Skip any fill bytes (0xFF) before the real marker byte.
    let markerOffset = offset;
    while (markerOffset < jpeg.length && jpeg[markerOffset] === 0xff) markerOffset += 1;
    if (markerOffset >= jpeg.length) throw new Error("malformed JPEG: truncated marker");
    const marker = 0xff00 | jpeg[markerOffset];
    const segmentStart = markerOffset - 1; // include the 0xFF byte
    if (marker === 0xffd9) {
      // The first EOI: keep it, then stop entirely. Anything appended after
      // it (MPF secondary images, a gain map with its own APP1) is dropped
      // rather than copied verbatim.
      chunks.push(jpeg.subarray(segmentStart, segmentStart + 2));
      offset = jpeg.length;
      break;
    }
    if (marker === 0xffda) {
      // Start of Scan: copy the scan header itself (its own length field
      // covers only the header, not the entropy-coded data that follows),
      // then resume as entropy-coded data.
      if (segmentStart + 4 > jpeg.length) throw new Error("malformed JPEG: truncated segment length");
      const scanLength = jpeg.readUInt16BE(segmentStart + 2);
      const scanHeaderEnd = segmentStart + 2 + scanLength;
      if (scanLength < 2 || scanHeaderEnd > jpeg.length) throw new Error("malformed JPEG: segment length runs past buffer");
      chunks.push(jpeg.subarray(segmentStart, scanHeaderEnd));
      offset = scanHeaderEnd;
      inScan = true;
      continue;
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

// Ensures `root` exists, is a real directory (not a symlink or something
// planted at that path) and is 0700, fixing the mode if it drifted. Throws
// rather than using an unsafe directory, which the caller turns into
// conversion_failed.
async function ensureSecureTempRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("attachment temp root is not a directory");
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (owner !== undefined && info.uid !== owner) throw new Error("attachment temp root is not owned by the current user");
  if ((info.mode & 0o777) !== 0o700) await chmod(root, 0o700);
  return root;
}

// Deletes att-* directories older than an hour under `root` (default: the
// standard temp root under the cache directory). Attachment temp directories
// are always removed in a `finally` right after use, so anything still here
// past the sweep age is leftover from a crash or a killed process, not live
// work. The server sweeps once at startup. Best-effort throughout: a directory
// another process is still using, or one that disappears mid-sweep, is left
// alone rather than failing the whole sweep.
export async function sweepAttachmentTemp(root: string = path.join(cacheDirectory(), "tmp")): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - TEMP_SWEEP_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(root, entry.name);
    try {
      const info = await stat(full);
      if (info.mtimeMs < cutoff) await rm(full, { recursive: true, force: true });
    } catch {
      // Raced with another sweep or the directory's own cleanup; not our problem.
    }
  }
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
  // A record path that isn't absolute even after "~" expansion would resolve
  // against this process's cwd inside realpath, not against Messages'
  // Attachments directory; reject it before ever calling realpath on it.
  if (!path.isAbsolute(resolvedPath)) return metadata("outside_attachments");

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
  // Exact ".." (the root's parent itself) or a ".." + separator prefix (an
  // actual escape) are outside the root; a real filename that merely starts
  // with ".." (e.g. "..foo") is not and must stay readable.
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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

// Drops up to 3 trailing bytes that form a UTF-8 sequence cut in half, so a
// bounded read never hands the decoder a lead byte with some of its
// continuation bytes missing (which would otherwise surface as U+FFFD).
function lastCompleteUtf8Boundary(bytes: Buffer): number {
  const length = bytes.length;
  for (let back = 1; back <= 3 && back <= length; back += 1) {
    const byte = bytes[length - back];
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte; look further back
    let need = 1;
    if ((byte & 0xe0) === 0xc0) need = 2;
    else if ((byte & 0xf0) === 0xe0) need = 3;
    else if ((byte & 0xf8) === 0xf0) need = 4;
    return need <= back ? length : length - back;
  }
  return length;
}

async function readText(file: string, sizeBytes: number): Promise<AttachmentContent> {
  const truncated = sizeBytes > ATTACHMENT_LIMITS.maxTextBytes;
  const readLength = truncated ? ATTACHMENT_LIMITS.maxTextBytes : sizeBytes;
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return metadata("unreadable");
  }
  try {
    const buffer = Buffer.allocUnsafe(readLength);
    let readTotal = 0;
    while (readTotal < readLength) {
      const { bytesRead } = await handle.read(buffer, readTotal, readLength - readTotal, readTotal);
      if (bytesRead === 0) break; // file shrank under us; take what we got
      readTotal += bytesRead;
    }
    const boundary = truncated ? lastCompleteUtf8Boundary(buffer.subarray(0, readTotal)) : readTotal;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, boundary));
    return { kind: "text", text, truncated };
  } catch {
    return metadata("unreadable");
  } finally {
    await handle.close();
  }
}

async function readImage(file: string, sips: string, options: ReadAttachmentOptions): Promise<AttachmentContent> {
  const totalMs = typeof options.timeoutMs === "number" && options.timeoutMs >= 1 ? options.timeoutMs : ATTACHMENT_LIMITS.sipsTimeoutMs;
  const deadline = Date.now() + totalMs;

  let dimensions: { width: number; height: number } | null;
  try {
    const output = await runSips(sips, ["-g", "pixelWidth", "-g", "pixelHeight", file], deadline);
    dimensions = parseDimensions(output);
  } catch {
    return metadata("conversion_failed");
  }
  if (!dimensions) return metadata("conversion_failed");
  const megapixels = (dimensions.width * dimensions.height) / 1_000_000;
  if (megapixels > ATTACHMENT_LIMITS.maxMegapixels) return metadata("image_too_large");

  // sips's -Z resizes to fit the given long edge either way, which means it
  // upscales a smaller image rather than leaving it alone; only pass -Z when
  // the source is actually bigger than the target.
  const edge = Math.min(ATTACHMENT_LIMITS.defaultLongEdge, validatedLongEdge(options.maxLongEdge));
  const longEdge = Math.max(dimensions.width, dimensions.height);

  const tempParent = options.tempRoot ?? path.join(cacheDirectory(), "tmp");
  let tempDir: string | undefined;
  try {
    await ensureSecureTempRoot(tempParent);
    // mkdtemp always creates the directory with 0700 permissions (mode is not
    // a supported option; the OS enforces this regardless of the umask).
    tempDir = await mkdtemp(path.join(tempParent, TEMP_PREFIX));
  } catch {
    return metadata("conversion_failed");
  }
  try {
    const outFile = path.join(tempDir, `${randomBytes(8).toString("hex")}.jpg`);
    const convertArgs = ["-s", "format", "jpeg", "-s", "formatOptions", "80"];
    if (longEdge > edge) convertArgs.push("-Z", String(edge));
    convertArgs.push(file, "--out", outFile);
    try {
      await runSips(sips, convertArgs, deadline);
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
    // Read the final size from the JPEG itself rather than a third sips
    // call; fall back to the pre-strip buffer in the (expected-never) case
    // that stripping somehow removed the SOF segment.
    const finalDims = readJpegDimensions(stripped) ?? readJpegDimensions(converted);
    if (!finalDims) return metadata("conversion_failed");
    return { kind: "image", mimeType: "image/jpeg", data: stripped, width: finalDims.width, height: finalDims.height };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
