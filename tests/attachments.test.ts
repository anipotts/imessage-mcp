import { execFile } from "node:child_process";
import {
  mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, truncate, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, readAttachmentContent, stripJpegMetadata, sweepAttachmentTemp } from "../src/attachments.js";
import { cacheDirectory } from "../src/cache.js";

const execFileAsync = promisify(execFile);

// ---- fixtures -----------------------------------------------------------

// CRC-32 table and function, used for PNG chunk checksums (no dependency
// beyond node built-ins, matching sqlite.ts / addressbook.ts style).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// A real, valid 2x2 RGBA PNG built by hand from raw bytes.
function makeSmallPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // Two 2x2 RGBA rows, each prefixed with a filter-type byte (0 = none).
  const raw = Buffer.concat([
    Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]),
    Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255]),
  ]);
  const idatData = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A minimal valid baseline JPEG (from the small PNG, via sips) with an
// injected APP1 (Exif-shaped) segment carrying a marker string, to verify
// stripJpegMetadata removes it.
function injectApp1(jpeg: Buffer, marker: string): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("fixture is not a JPEG");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), Buffer.from(marker, "ascii")]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2, 0);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

// A real APP1 Exif segment: "Exif\0\0" followed by a hand-assembled
// little-endian TIFF structure with a genuine IFD0 (Make tag carrying an
// ASCII secret, plus a GPSInfo IFD pointer entry pointing at a minimal but
// structurally valid GPS IFD), not just a marker string like injectApp1
// above. Proves the stripper removes real EXIF, not merely a text pattern.
function injectRealExifApp1(jpeg: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("fixture is not a JPEG");
  const makeString = Buffer.from("GPSMAKERSECRET\0", "ascii"); // 15 bytes incl. NUL
  const tiff = Buffer.alloc(59);
  tiff.write("II", 0, "ascii"); // little-endian byte order
  tiff.writeUInt16LE(42, 2); // TIFF magic
  tiff.writeUInt32LE(8, 4); // offset to IFD0
  tiff.writeUInt16LE(2, 8); // IFD0: 2 entries
  // Entry 1: Make (0x010F), type ASCII (2), count 15, offset 38 (doesn't fit inline).
  tiff.writeUInt16LE(0x010f, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(15, 14);
  tiff.writeUInt32LE(38, 18);
  // Entry 2: GPSInfo (0x8825), type LONG (4), count 1, value = offset 53 (the GPS IFD).
  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(53, 30);
  tiff.writeUInt32LE(0, 34); // IFD0 -> next IFD: none
  makeString.copy(tiff, 38);
  tiff.writeUInt16LE(0, 53); // GPS IFD: 0 entries
  tiff.writeUInt32LE(0, 55); // GPS IFD -> next IFD: none

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2, 0);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

// An APP13 (Photoshop IRB) segment, the other metadata carrier competitors'
// EXIF strippers commonly miss.
function injectApp13(jpeg: Buffer, text: string): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("fixture is not a JPEG");
  const payload = Buffer.from(`Photoshop 3.0\0${text}`, "ascii");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2, 0);
  const segment = Buffer.concat([Buffer.from([0xff, 0xed]), length, payload]); // APP13
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

// True if any APPn (0xFFE0-0xFFEF) or COM (0xFFFE) segment appears before the
// first SOS. Test-only verification, deliberately simple (assumes the input
// is well-formed, which is all that's ever fed to it here).
function hasAppnOrComBeforeSos(jpeg: Buffer): boolean {
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return false;
    let markerOffset = offset;
    while (jpeg[markerOffset] === 0xff) markerOffset += 1;
    const marker = 0xff00 | jpeg[markerOffset];
    if (marker === 0xffda) return false;
    if ((marker >= 0xffe0 && marker <= 0xffef) || marker === 0xfffe) return true;
    if ((marker >= 0xffd0 && marker <= 0xffd7) || marker === 0xff01 || marker === 0xffd9) {
      offset = markerOffset + 1;
      continue;
    }
    const segmentStart = markerOffset - 1;
    const length = jpeg.readUInt16BE(segmentStart + 2);
    offset = segmentStart + 2 + length;
  }
  return false;
}

const SIPS = "/usr/bin/sips";
let sipsAvailable = true;
try {
  await execFileAsync(SIPS, ["--help"]);
} catch {
  sipsAvailable = false;
}

// ---- test harness ---------------------------------------------------------

let home: string;
let attachmentsRoot: string;
let tempRoot: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "imessage-mcp-home-"));
  attachmentsRoot = path.join(home, "Library/Messages/Attachments");
  await mkdir(attachmentsRoot, { recursive: true });
  // Every test passes its own tempRoot explicitly so the suite never touches
  // this machine's real ~/Library/Caches/imessage-mcp (the production default).
  tempRoot = path.join(home, "cache-tmp");
});

afterEach(async () => {
  // Best-effort cleanup; the OS temp dir is periodically reaped regardless.
  await execFileAsync("rm", ["-rf", home]).catch(() => {});
});

function record(overrides: Partial<{ filename: string | null; mime_type: string | null; uti: string | null; total_bytes: number | null }> = {}) {
  return {
    filename: null,
    mime_type: null,
    uti: null,
    total_bytes: null,
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------

describe("readAttachmentContent: images", () => {
  it.skipIf(!sipsAvailable)("converts a small PNG to a stripped JPEG without upscaling it", async () => {
    const dir = path.join(attachmentsRoot, "ab/11/uuid1");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "IMG_0001.PNG");
    await writeFile(file, makeSmallPng());

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot, tempRoot },
    );

    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.mimeType).toBe("image/jpeg");
      // The source is 2x2, far below the 1600px default long edge: sips's -Z
      // resizes to fit a target either way (it will upscale a smaller image
      // unless the caller skips -Z entirely), so a correct implementation
      // leaves this image at its original 2x2 size rather than blowing it
      // up to 1600x1600.
      expect(result.width).toBe(2);
      expect(result.height).toBe(2);
      // JPEG magic bytes.
      expect(result.data[0]).toBe(0xff);
      expect(result.data[1]).toBe(0xd8);
    }
  });

  it.skipIf(!sipsAvailable)(
    "falls back to the default long edge for an invalid maxLongEdge instead of passing it to sips",
    async () => {
      const dir = path.join(attachmentsRoot, "ab/13/uuid1c");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "IMG_0001c.PNG");
      await writeFile(file, makeSmallPng());

      // 0 and a negative number are not "an integer >= 1"; if they leaked
      // through unvalidated as a sips -Z argument, sips would either reject
      // it or produce a degenerate (near-zero-size) image, not the untouched
      // 2x2 source a correct fallback to the 1600px default produces.
      for (const invalid of [0, -5]) {
        const result = await readAttachmentContent(
          record({ filename: file, mime_type: "image/png", uti: "public.png" }),
          { home, attachmentsRoot, tempRoot, maxLongEdge: invalid },
        );
        expect(result.kind, `maxLongEdge=${invalid}`).toBe("image");
        if (result.kind === "image") {
          expect(result.width, `maxLongEdge=${invalid}`).toBe(2);
          expect(result.height, `maxLongEdge=${invalid}`).toBe(2);
        }
      }
    },
  );

  it.skipIf(!sipsAvailable)(
    "rejects an oversized image after exactly one sips invocation, without converting it",
    async () => {
      const dir = path.join(attachmentsRoot, "ab/12/uuid1b");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "IMG_huge.PNG");
      await writeFile(file, makeSmallPng());

      // A stub sips that always reports an 8000x8000 source (64 megapixels,
      // above ATTACHMENT_LIMITS.maxMegapixels) and logs every invocation's
      // arguments, so the test can prove the megapixel ceiling is enforced
      // from the dimension probe alone: no conversion call ever happens.
      // (A real 8000x8000 sips conversion would be slow and flaky in CI;
      // this proves the same code path without paying that cost.)
      const logFile = path.join(home, "sips-invocations.log");
      const stubSips = path.join(home, "stub-sips-oversized.sh");
      await writeFile(
        stubSips,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${logFile}"`,
          'if [ "$1" = "-g" ]; then',
          "  echo 'pixelWidth: 8000'",
          "  echo 'pixelHeight: 8000'",
          "  exit 0",
          "fi",
          "echo 'stub-sips: unexpected conversion call' >&2",
          "exit 1",
          "",
        ].join("\n"),
      );
      await execFileAsync("chmod", ["755", stubSips]);

      const result = await readAttachmentContent(
        record({ filename: file, mime_type: "image/png", uti: "public.png" }),
        { home, attachmentsRoot, tempRoot, sips: stubSips },
      );

      expect(result).toEqual({ kind: "metadata", reason: "image_too_large" });
      const log = await readFile(logFile, "utf-8");
      const invocations = log.trim().split("\n").filter((line) => line.length > 0);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain("-g");
    },
  );

  it.skipIf(!sipsAvailable)("strips an injected APP1 Exif segment from the output", async () => {
    const dir = path.join(attachmentsRoot, "ab/22/uuid2");
    await mkdir(dir, { recursive: true });
    const pngFile = path.join(dir, "source.png");
    await writeFile(pngFile, makeSmallPng());

    // Produce a real baseline JPEG via sips, then inject a marker segment.
    const plainJpeg = path.join(dir, "plain.jpg");
    await execFileAsync(SIPS, ["-s", "format", "jpeg", pngFile, "--out", plainJpeg]);
    const withMarker = injectApp1(await readFile(plainJpeg), "GPS-SECRET");
    const taggedFile = path.join(dir, "IMG_0002.JPG");
    await writeFile(taggedFile, withMarker);
    // Sanity: the marker really is present in the tagged input file.
    expect(withMarker.includes("GPS-SECRET")).toBe(true);

    const result = await readAttachmentContent(
      record({ filename: taggedFile, mime_type: "image/jpeg", uti: "public.jpeg" }),
      { home, attachmentsRoot, tempRoot },
    );

    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.data.includes("GPS-SECRET")).toBe(false);
    }
  });

  it.skipIf(!sipsAvailable)(
    "strips a real EXIF APP1 (TIFF/IFD0 Make + GPSInfo pointer) and an APP13, leaving no APPn/COM marker or the secret value",
    async () => {
      const dir = path.join(attachmentsRoot, "ab/23/uuid2b");
      await mkdir(dir, { recursive: true });
      const pngFile = path.join(dir, "source.png");
      await writeFile(pngFile, makeSmallPng());
      const plainJpeg = path.join(dir, "plain.jpg");
      await execFileAsync(SIPS, ["-s", "format", "jpeg", pngFile, "--out", plainJpeg]);
      const base = await readFile(plainJpeg);

      const withExif = injectRealExifApp1(base);
      const withExifAndApp13 = injectApp13(withExif, "Photoshop IRB data, also fake");
      const taggedFile = path.join(dir, "IMG_0002b.JPG");
      await writeFile(taggedFile, withExifAndApp13);
      // Sanity: the secret is really present in the input, and both segments exist.
      expect(withExifAndApp13.includes("GPSMAKERSECRET")).toBe(true);

      // Direct unit test of stripJpegMetadata on this exact fixture.
      const strippedDirect = stripJpegMetadata(withExifAndApp13);
      expect(strippedDirect.includes("GPSMAKERSECRET")).toBe(false);
      expect(hasAppnOrComBeforeSos(strippedDirect)).toBe(false);

      const result = await readAttachmentContent(
        record({ filename: taggedFile, mime_type: "image/jpeg", uti: "public.jpeg" }),
        { home, attachmentsRoot, tempRoot },
      );
      expect(result.kind).toBe("image");
      if (result.kind === "image") {
        expect(result.data.includes("GPSMAKERSECRET")).toBe(false);
        expect(hasAppnOrComBeforeSos(result.data)).toBe(false);
      }
    },
  );

  it.skipIf(!sipsAvailable)(
    "drops bytes appended after EOI (a trailing secondary JPEG with its own APP1) while the output still decodes",
    async () => {
      const dir = path.join(attachmentsRoot, "ab/24/uuid2c");
      await mkdir(dir, { recursive: true });
      const pngFile = path.join(dir, "source.png");
      await writeFile(pngFile, makeSmallPng());
      const plainJpeg = path.join(dir, "plain.jpg");
      await execFileAsync(SIPS, ["-s", "format", "jpeg", pngFile, "--out", plainJpeg]);
      const primary = await readFile(plainJpeg);

      // A second, independent JPEG (its own SOI..EOI) with an APP1 carrying a
      // marker, appended right after the primary image's EOI, the shape of
      // an MPF secondary image or a gain map some encoders tack on.
      const secondaryPng = path.join(dir, "secondary.png");
      await writeFile(secondaryPng, makeSmallPng());
      const secondaryPlain = path.join(dir, "secondary-plain.jpg");
      await execFileAsync(SIPS, ["-s", "format", "jpeg", secondaryPng, "--out", secondaryPlain]);
      const secondary = injectApp1(await readFile(secondaryPlain), "TRAILGPS");

      const withTrailer = Buffer.concat([primary, secondary]);
      const taggedFile = path.join(dir, "IMG_0002c.JPG");
      await writeFile(taggedFile, withTrailer);
      expect(withTrailer.includes("TRAILGPS")).toBe(true);

      const stripped = stripJpegMetadata(withTrailer);
      expect(stripped.includes("TRAILGPS")).toBe(false);
      // Exactly one EOI should survive (the primary's); the trailing bytes,
      // secondary SOI included, must be gone entirely.
      expect(stripped.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
      expect(stripped.length).toBeLessThan(withTrailer.length);

      // The output must still be a valid, decodable JPEG. sips -g reports
      // "-g" state without decoding pixel data, so use a real format
      // conversion (which does decode) to check decodability instead.
      const outDir = await mkdtemp(path.join(tmpdir(), "imessage-mcp-trailer-"));
      const strippedFile = path.join(outDir, "stripped.jpg");
      await writeFile(strippedFile, stripped);
      const convertedPng = path.join(outDir, "roundtrip.png");
      await expect(
        execFileAsync(SIPS, ["-s", "format", "png", strippedFile, "--out", convertedPng]),
      ).resolves.toBeTruthy();
      await stat(convertedPng); // throws if sips did not actually produce it
      await execFileAsync("rm", ["-rf", outDir]).catch(() => {});
    },
  );

  it("returns conversion_failed when sips times out or fails", async () => {
    const dir = path.join(attachmentsRoot, "ab/33/uuid3");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "IMG_0003.PNG");
    await writeFile(file, makeSmallPng());

    const failingSips = path.join(home, "fake-sips.sh");
    await writeFile(failingSips, "#!/bin/sh\nexit 1\n");
    await execFileAsync("chmod", ["755", failingSips]);

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot, tempRoot, sips: failingSips },
    );

    expect(result).toEqual({ kind: "metadata", reason: "conversion_failed" });
  });

  it("returns conversion_failed within 2s when sips hangs past a short timeoutMs", async () => {
    const dir = path.join(attachmentsRoot, "ab/34/uuid3b");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "IMG_0004.PNG");
    await writeFile(file, makeSmallPng());

    // A stub that reports plausible dimensions for -g but sleeps for 5s on
    // any other invocation (the conversion call), far past the 200ms budget.
    const slowSips = path.join(home, "slow-sips.sh");
    await writeFile(
      slowSips,
      ["#!/bin/sh", 'if [ "$1" = "-g" ]; then', "  echo 'pixelWidth: 100'", "  echo 'pixelHeight: 100'", "  exit 0", "fi", "sleep 5", "exit 0", ""].join("\n"),
    );
    await execFileAsync("chmod", ["755", slowSips]);

    const started = Date.now();
    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot, tempRoot, sips: slowSips, timeoutMs: 200 },
    );
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({ kind: "metadata", reason: "conversion_failed" });
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("readAttachmentContent: path confinement and bounds", () => {
  it("returns outside_attachments for a symlink escaping the root", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "imessage-mcp-outside-"));
    const outsideFile = path.join(outsideDir, "secret.png");
    await writeFile(outsideFile, makeSmallPng());
    const linkPath = path.join(attachmentsRoot, "escape.png");
    await symlink(outsideFile, linkPath);

    const result = await readAttachmentContent(
      record({ filename: linkPath, mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "metadata", reason: "outside_attachments" });
    await execFileAsync("rm", ["-rf", outsideDir]).catch(() => {});
  });

  it("returns outside_attachments for a traversal through the tilde-expanded home path", async () => {
    // "../../../" from Attachments cancels exactly the 3 segments Attachments
    // sits under (Library/Messages/Attachments), landing at $HOME/etc/hosts -
    // outside attachmentsRoot but still inside this test's fake home. Create
    // that decoy so realpath actually resolves it and the containment check
    // (not a missing-file check) is what rejects it.
    await mkdir(path.join(home, "etc"), { recursive: true });
    await writeFile(path.join(home, "etc/hosts"), "decoy outside attachmentsRoot", "utf-8");

    const result = await readAttachmentContent(
      record({ filename: "~/Library/Messages/Attachments/../../../etc/hosts", mime_type: "text/plain" }),
      { home, attachmentsRoot },
    );
    expect(result).toEqual({ kind: "metadata", reason: "outside_attachments" });
  });

  it("returns outside_attachments for a non-absolute record path (never resolved against process cwd)", async () => {
    const result = await readAttachmentContent(
      record({ filename: "relative/not-anchored.png", mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot },
    );
    expect(result).toEqual({ kind: "metadata", reason: "outside_attachments" });
  });

  it("reads a real file whose name literally starts with \"..\" (not a traversal)", async () => {
    // A filename like "..foo" is not an escape: path.relative(root, file)
    // for it is "..foo", which merely STARTS WITH ".." as a string without
    // being an actual ".." path segment (that would need a following path
    // separator, or the whole relative path being exactly "..").
    const file = path.join(attachmentsRoot, "..foo");
    await writeFile(file, "not an escape, just an odd filename", "utf-8");

    const result = await readAttachmentContent(record({ filename: file, mime_type: "text/plain" }), { home, attachmentsRoot });

    expect(result).toEqual({ kind: "text", text: "not an escape, just an odd filename", truncated: false });
  });

  it("returns not_downloaded for a missing file", async () => {
    const missing = path.join(attachmentsRoot, "ab/44/uuid4/IMG_missing.HEIC");
    const result = await readAttachmentContent(
      record({ filename: missing, mime_type: "image/heic", uti: "public.heic" }),
      { home, attachmentsRoot },
    );
    expect(result).toEqual({ kind: "metadata", reason: "not_downloaded" });
  });

  it("returns not_downloaded for a null filename", async () => {
    const result = await readAttachmentContent(record({ filename: null }), { home, attachmentsRoot });
    expect(result).toEqual({ kind: "metadata", reason: "not_downloaded" });
  });

  it("returns too_large for a file above the byte ceiling, checked with stat before reading", async () => {
    const dir = path.join(attachmentsRoot, "ab/55/uuid5");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "huge.bin");
    // Sparse file: sized above the limit without writing real bytes to disk.
    await writeFile(file, "");
    await truncate(file, ATTACHMENT_LIMITS.maxFileBytes + 1024 * 1024);

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "metadata", reason: "too_large" });
  });
});

describe("readAttachmentContent: text", () => {
  it("reads a small text/plain file in full", async () => {
    const dir = path.join(attachmentsRoot, "ab/66/uuid6");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "note.txt");
    await writeFile(file, "hello from a synthetic message attachment", "utf-8");

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "text/plain" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "text", text: "hello from a synthetic message attachment", truncated: false });
  });

  it("truncates a text/plain file above 64 KB and reads no more than the cap", async () => {
    const dir = path.join(attachmentsRoot, "ab/77/uuid7");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "big.txt");
    const content = "a".repeat(ATTACHMENT_LIMITS.maxTextBytes + 5000);
    await writeFile(file, content, "utf-8");

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "text/plain" }),
      { home, attachmentsRoot },
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(ATTACHMENT_LIMITS.maxTextBytes);
    }
  });

  it("backs off to the last complete UTF-8 boundary when the cap splits a multibyte character", async () => {
    const dir = path.join(attachmentsRoot, "ab/78/uuid7b");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "multibyte.txt");
    // "€" is 3 bytes (E2 82 AC). maxTextBytes (65536) is not a multiple of 3
    // (65536 % 3 === 1), so a naive byte-for-byte cut at exactly the limit
    // lands one byte into a "€", which a lossless decode must never emit as
    // a replacement character.
    const euroCount = Math.ceil((ATTACHMENT_LIMITS.maxTextBytes + 3000) / 3);
    const content = "€".repeat(euroCount);
    await writeFile(file, content, "utf-8");

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "text/plain" }),
      { home, attachmentsRoot },
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(ATTACHMENT_LIMITS.maxTextBytes);
      expect(result.text.includes("�")).toBe(false);
      // Every character read back must be a complete, real "€" - not a
      // partially decoded / replacement character of any kind.
      expect([...result.text].every((char) => char === "€")).toBe(true);
    }
  });

  it("treats text/vcard as metadata, not readable text", async () => {
    const dir = path.join(attachmentsRoot, "ab/88/uuid8");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "contact.vcf");
    await writeFile(file, "BEGIN:VCARD\nFN:Test Person\nEND:VCARD\n", "utf-8");

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "text/vcard" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "metadata", reason: "unsupported_type" });
  });

  it("treats text/x-vlocation as metadata, not readable text", async () => {
    const dir = path.join(attachmentsRoot, "ab/89/uuid9");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "location.loc.vcf");
    await writeFile(file, "BEGIN:VLOCATION\nEND:VLOCATION\n", "utf-8");

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "text/x-vlocation" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "metadata", reason: "unsupported_type" });
  });
});

describe("readAttachmentContent: unsupported types", () => {
  it("returns unsupported_type for a PDF (no PDF parser ships)", async () => {
    const dir = path.join(attachmentsRoot, "ab/99/uuid10");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "doc.pdf");
    await writeFile(file, "%PDF-1.4\n%fake\n");

    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "application/pdf" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "metadata", reason: "unsupported_type" });
  });
});

describe("stripJpegMetadata", () => {
  it.skipIf(!sipsAvailable)("removes APPn/COM segments while keeping the image decodable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imessage-mcp-strip-"));
    const pngFile = path.join(dir, "src.png");
    await writeFile(pngFile, makeSmallPng());
    const plainJpeg = path.join(dir, "plain.jpg");
    await execFileAsync(SIPS, ["-s", "format", "jpeg", pngFile, "--out", plainJpeg]);
    const base = await readFile(plainJpeg);

    let tagged = injectApp1(base, "GPS-SECRET");
    // Also inject a COM segment to confirm it's dropped too.
    const comPayload = Buffer.from("comment to drop", "ascii");
    const comLength = Buffer.alloc(2);
    comLength.writeUInt16BE(comPayload.length + 2, 0);
    const comSegment = Buffer.concat([Buffer.from([0xff, 0xfe]), comLength, comPayload]);
    tagged = Buffer.concat([tagged.subarray(0, 2), comSegment, tagged.subarray(2)]);

    const stripped = stripJpegMetadata(tagged);
    expect(stripped.includes("GPS-SECRET")).toBe(false);
    expect(stripped.includes("comment to drop")).toBe(false);

    const outFile = path.join(dir, "stripped.jpg");
    await writeFile(outFile, stripped);
    const { stdout } = await execFileAsync(SIPS, ["-g", "pixelWidth", outFile]);
    expect(/pixelWidth:\s*\d+/.test(stdout)).toBe(true);

    await execFileAsync("rm", ["-rf", dir]).catch(() => {});
  });

  it("throws on input with no SOI marker", () => {
    expect(() => stripJpegMetadata(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toThrow();
  });

  it("throws on a truncated segment whose declared length runs past the buffer", () => {
    // SOI, then an APP1 marker claiming a length far larger than the buffer.
    const malformed = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
    expect(() => stripJpegMetadata(malformed)).toThrow();
  });

  it("throws on an empty buffer", () => {
    expect(() => stripJpegMetadata(Buffer.alloc(0))).toThrow();
  });
});

describe("path resolution edge cases", () => {
  it("resolves a leading ~ against options.home", async () => {
    const dir = path.join(attachmentsRoot, "ab/tilde/uuid11");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "note.txt");
    await writeFile(file, "tilde-resolved content", "utf-8");
    const tildeFilename = "~/Library/Messages/Attachments/ab/tilde/uuid11/note.txt";

    const result = await readAttachmentContent(
      record({ filename: tildeFilename, mime_type: "text/plain" }),
      { home, attachmentsRoot },
    );

    expect(result).toEqual({ kind: "text", text: "tilde-resolved content", truncated: false });
  });
});

describe("attachment temp directory", () => {
  it.skipIf(!sipsAvailable)("creates the default temp root under cacheDirectory()/tmp, mode 0700, with att- prefixed subdirectories", async () => {
    // Exercises the real default (no tempRoot override) to prove it actually
    // resolves under the shared cache directory rather than the OS tmpdir,
    // then cleans up after itself.
    const dir = path.join(attachmentsRoot, "ab/temp-default/uuid");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "note.png");
    await writeFile(file, makeSmallPng());

    const defaultTempRoot = path.join(cacheDirectory(), "tmp");
    const result = await readAttachmentContent(
      record({ filename: file, mime_type: "image/png", uti: "public.png" }),
      { home, attachmentsRoot },
    );
    expect(result.kind).toBe("image");

    const info = await stat(defaultTempRoot);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
    // The mkdtemp'd att-* subdirectory is removed again after each call.
    const leftovers = (await readdir(defaultTempRoot)).filter((name) => name.startsWith("att-"));
    expect(leftovers).toEqual([]);
  });

  it("sweepAttachmentTemp removes att-* directories older than an hour, leaving fresh ones and non-matching entries", async () => {
    const root = path.join(home, "sweep-root");
    await mkdir(root, { recursive: true });
    const old = path.join(root, "att-old");
    const fresh = path.join(root, "att-fresh");
    // Also old, so a broken prefix filter (one that ignores the "att-" name
    // requirement and sweeps by age alone) would incorrectly remove this too.
    const unrelated = path.join(root, "not-attachment-related");
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(old, "leftover.jpg"), "x");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await utimes(unrelated, twoHoursAgo, twoHoursAgo);

    await sweepAttachmentTemp(root);

    const remaining = (await readdir(root)).sort();
    expect(remaining).toEqual(["att-fresh", "not-attachment-related"].sort());
  });

  it("sweepAttachmentTemp is a no-op (never throws) when the root does not exist", async () => {
    await expect(sweepAttachmentTemp(path.join(home, "does-not-exist"))).resolves.toBeUndefined();
  });
});
