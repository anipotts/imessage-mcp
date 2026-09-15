// The encrypted checkpoint of the search index. The serialized index is sealed
// with AES-256-GCM under a key derived from anchor rows sampled from the live
// chat.db (the newest message of the most recently active conversations), so
// only a process that can read the current database can open the file. The
// key never touches disk; the header names the anchors, a fresh salt and a
// fresh nonce, and the whole header is authenticated. Reads never throw: any
// mismatch, truncation, missing anchor or failed tag is simply a cache miss.
//
// Limitation: with few active conversations the anchors may all come from one
// chat, so the key rests on rows the other person's devices also hold. The
// cache guards against other local processes and stale backups, not against
// someone who already has that thread and this file.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type Database from "./sqlite.js";

export const CACHE_FORMAT_VERSION = 1;

const MAGIC = Buffer.from("IMCACHE1", "latin1");
const HKDF_INFO = "imessage-mcp cache v1";
const TARGET_ANCHORS = 32;
const MAX_ANCHORS = 256;
const MAX_PLAINTEXT_BYTES = 1024 * 1024 * 1024;
const MAX_GUID_BYTES = 0xffff;
const SOURCE_HASH_CHARS = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CHUNK_BYTES = 16 * 1024 * 1024;
// magic, format version, schema version, source hash, anchor count
const PREFIX_BYTES = MAGIC.length + 2 + 4 + SOURCE_HASH_CHARS + 2;
// salt, nonce, plaintext length
const SUFFIX_BYTES = SALT_BYTES + NONCE_BYTES + 8;
const SOURCE_HASH_PATTERN = /^[0-9a-f]{32}$/;

export function cacheDirectory(): string {
  return path.join(homedir(), "Library/Caches/imessage-mcp");
}

export function sourceHash(canonicalDatabasePath: string): string {
  return createHash("sha256").update(canonicalDatabasePath, "utf8").digest("hex").slice(0, SOURCE_HASH_CHARS);
}

function rowid(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new RangeError("unsupported message ROWID");
  return number;
}

// The newest message of each of the 32 most recently active conversations plus
// the newest row in the table, topped up with the newest remaining rows until
// there are 32 (or the table runs out). Sorted ascending, no duplicates.
export function sampleAnchors(source: Database): number[] {
  const newest = source.prepare("SELECT MAX(ROWID) FROM message").pluck().safeIntegers().get();
  if (newest === null || newest === undefined) return [];
  const anchors = new Set<number>([rowid(newest)]);
  const chats = source.prepare(
    `SELECT MAX(j.message_id)
     FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
     GROUP BY j.chat_id
     ORDER BY MAX(m.date) DESC, j.chat_id ASC
     LIMIT ?`,
  ).pluck().safeIntegers().all(TARGET_ANCHORS);
  for (const value of chats) anchors.add(rowid(value));
  if (anchors.size < TARGET_ANCHORS) {
    const recent = source.prepare("SELECT ROWID FROM message ORDER BY ROWID DESC LIMIT ?")
      .pluck().safeIntegers().all(TARGET_ANCHORS + anchors.size);
    for (const value of recent) {
      if (anchors.size >= TARGET_ANCHORS) break;
      anchors.add(rowid(value));
    }
  }
  return [...anchors].sort((left, right) => left - right);
}

function lengthPrefixed(bytes: Buffer): Buffer {
  if (bytes.length > MAX_GUID_BYTES) throw new RangeError("anchor field too long");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function integer64(value: unknown): Buffer {
  const out = Buffer.alloc(8);
  const big = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : 0n;
  out.writeBigUInt64BE(BigInt.asUintN(64, big));
  return out;
}

// The key material for a set of anchors, or null when any anchor row is gone.
function deriveKey(source: Database, anchors: readonly number[], salt: Buffer): Buffer | null {
  const statement = source.prepare("SELECT ROWID AS rowid, guid, date, handle_id, is_from_me FROM message WHERE ROWID = ?").safeIntegers();
  const hash = createHash("sha256");
  for (const anchor of anchors) {
    const row = statement.get(anchor) as { rowid: bigint; guid: unknown; date: unknown; handle_id: unknown; is_from_me: unknown } | undefined;
    if (!row) return null;
    const flag = Buffer.alloc(1);
    flag[0] = Number(typeof row.is_from_me === "bigint" || typeof row.is_from_me === "number" ? row.is_from_me : 0) & 0xff;
    hash.update(integer64(row.rowid));
    hash.update(lengthPrefixed(Buffer.from(row.guid === null ? "" : String(row.guid), "utf8")));
    hash.update(lengthPrefixed(Buffer.from(row.date === null ? "" : String(row.date), "latin1")));
    hash.update(integer64(row.handle_id));
    hash.update(flag);
  }
  return Buffer.from(hkdfSync("sha256", hash.digest(), salt, HKDF_INFO, 32));
}

// The archive identifier used by cursors (plan 3.6). An identifier only, never
// key material. Each guid is framed with a 4-byte length so no guid can fail it.
export function databaseIdentity(source: Database): string {
  const guids = source.prepare("SELECT guid FROM message ORDER BY ROWID ASC LIMIT ?").pluck().all(TARGET_ANCHORS);
  const hash = createHash("sha256");
  for (const guid of guids) {
    const bytes = Buffer.from(guid === null ? "" : String(guid), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function encodeHeader(schemaVersion: number, hash: string, anchors: readonly number[], salt: Buffer, nonce: Buffer, plaintextLength: number): Buffer {
  const header = Buffer.alloc(PREFIX_BYTES + anchors.length * 8 + SUFFIX_BYTES);
  let offset = MAGIC.copy(header, 0);
  offset = header.writeUInt16BE(CACHE_FORMAT_VERSION, offset);
  offset = header.writeUInt32BE(schemaVersion, offset);
  offset += header.write(hash, offset, SOURCE_HASH_CHARS, "latin1");
  offset = header.writeUInt16BE(anchors.length, offset);
  for (const anchor of anchors) offset = header.writeBigUInt64BE(BigInt(anchor), offset);
  offset += salt.copy(header, offset);
  offset += nonce.copy(header, offset);
  header.writeBigUInt64BE(BigInt(plaintextLength), offset);
  return header;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, bytes, offset, length - offset, position + offset);
    if (read === 0) return null;
    offset += read;
  }
  return bytes;
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) throw new Error("cache directory is not a directory");
  if ((stat.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
}

export function writeCacheFile(input: { path: string; plaintext: Buffer; source: Database; schemaVersion: number; sourceHash: string }): void {
  const { plaintext } = input;
  if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_PLAINTEXT_BYTES) throw new RangeError("cache plaintext exceeds 1 GiB");
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 0 || input.schemaVersion > 0xffff_ffff) {
    throw new RangeError("invalid schema version");
  }
  if (!SOURCE_HASH_PATTERN.test(input.sourceHash)) throw new RangeError("invalid source hash");
  const anchors = sampleAnchors(input.source);
  // An empty database has nothing to key from; a key anyone could derive is no key.
  if (anchors.length === 0) throw new Error("no anchor rows to derive a cache key");
  if (anchors.length > MAX_ANCHORS) throw new RangeError("too many anchor rows");
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveKey(input.source, anchors, salt);
  if (!key) throw new Error("anchor row disappeared while deriving the cache key");
  const header = encodeHeader(input.schemaVersion, input.sourceHash, anchors, salt, nonce, plaintext.length);

  const directory = path.dirname(input.path);
  const temporary = `${input.path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    secureDirectory(directory);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    writeAll(fd, header);
    for (let offset = 0; offset < plaintext.length; offset += CHUNK_BYTES) {
      writeAll(fd, cipher.update(plaintext.subarray(offset, offset + CHUNK_BYTES)));
    }
    writeAll(fd, cipher.final());
    writeAll(fd, cipher.getAuthTag());
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, input.path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // never created
    }
    // Node's fs errors carry the full path in both .message and .path (e.g.
    // "EACCES: permission denied, open '/Users/.../cache/x.tmp'"); only the
    // errno code is safe to surface, never the message or path.
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "UNKNOWN";
    throw new Error("cache write failed", { cause: { code } });
  } finally {
    key.fill(0);
  }
  // Make the rename durable; a directory that refuses fsync still holds a valid file.
  try {
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // best effort
  }
}

function openCache(fd: number, input: { source: Database; schemaVersion: number; sourceHash: string }): Buffer | null {
  const size = fstatSync(fd).size;
  const maxSize = PREFIX_BYTES + MAX_ANCHORS * 8 + SUFFIX_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES;
  if (size < PREFIX_BYTES + 8 + SUFFIX_BYTES + TAG_BYTES || size > maxSize) return null;
  const prefix = readExactly(fd, PREFIX_BYTES, 0);
  if (!prefix || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  let offset = MAGIC.length;
  if (prefix.readUInt16BE(offset) !== CACHE_FORMAT_VERSION) return null;
  offset += 2;
  if (prefix.readUInt32BE(offset) !== input.schemaVersion) return null;
  offset += 4;
  if (prefix.toString("latin1", offset, offset + SOURCE_HASH_CHARS) !== input.sourceHash) return null;
  offset += SOURCE_HASH_CHARS;
  const count = prefix.readUInt16BE(offset);
  if (count === 0 || count > MAX_ANCHORS) return null;
  const headerLength = PREFIX_BYTES + count * 8 + SUFFIX_BYTES;
  if (size < headerLength + TAG_BYTES) return null;
  const rest = readExactly(fd, headerLength - PREFIX_BYTES, PREFIX_BYTES);
  if (!rest) return null;
  const header = Buffer.concat([prefix, rest]);

  offset = PREFIX_BYTES;
  const anchors: number[] = [];
  for (let index = 0; index < count; index += 1, offset += 8) {
    const value = header.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const anchor = Number(value);
    // Writers store anchors strictly ascending; anything else was not written by one.
    if (anchors.length > 0 && anchor <= anchors[anchors.length - 1]) return null;
    anchors.push(anchor);
  }
  const salt = header.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const nonce = header.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const length = header.readBigUInt64BE(offset);
  if (length > BigInt(MAX_PLAINTEXT_BYTES)) return null;
  const plaintextLength = Number(length);
  if (size !== headerLength + plaintextLength + TAG_BYTES) return null;

  const key = deriveKey(input.source, anchors, salt);
  if (!key) return null;
  const body = readExactly(fd, plaintextLength + TAG_BYTES, headerLength);
  if (!body) {
    key.fill(0);
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(body.subarray(plaintextLength));
    const chunks: Buffer[] = [];
    for (let position = 0; position < plaintextLength; position += CHUNK_BYTES) {
      chunks.push(decipher.update(body.subarray(position, Math.min(position + CHUNK_BYTES, plaintextLength))));
    }
    chunks.push(decipher.final());
    return Buffer.concat(chunks, plaintextLength);
  } finally {
    key.fill(0);
  }
}

export function readCacheFile(input: { path: string; source: Database; schemaVersion: number; sourceHash: string }): Buffer | null {
  let fd: number;
  try {
    // O_NONBLOCK matters for a FIFO: opening one O_RDONLY blocks until a
    // writer opens the other end, which would otherwise hang the server
    // indefinitely on a maliciously (or accidentally) planted pipe at the
    // cache path. With O_NONBLOCK the open returns immediately regardless,
    // and the isFile() check below rejects it either way.
    fd = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return openCache(fd, input);
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}
