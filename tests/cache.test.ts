import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_FORMAT_VERSION, cacheDirectory, databaseIdentity, readCacheFile, sampleAnchors, sourceHash, writeCacheFile,
} from "../src/cache.js";
import Database from "../src/sqlite.js";

// Header layout: magic 8, format 2, schema 4, source hash 32, count 2, anchors
// 8 each, salt 32, nonce 12, plaintext length 8.
const PREFIX = 48;
const SUFFIX = 52;
const BASE_DATE = 800_000_000_000_000_000n; // nanoseconds, beyond 2^53
const SCHEMA = 7;
const HASH = sourceHash("/synthetic/chat.db");

const directories: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-mcp-cache-"));
  directories.push(directory);
  return directory;
}

interface Message { rowid: number; chat: number | null; date: bigint; guid?: string }

// A chat.db-shaped database with the columns the cache reads.
function chatDatabase(messages: Message[], guidPrefix = "guid"): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY(chat_id, message_id));
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, handle_id INTEGER,
      date INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0
    );
  `);
  addMessages(db, messages, guidPrefix);
  return db;
}

function addMessages(db: Database, messages: Message[], guidPrefix = "guid"): void {
  const insert = db.prepare("INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me) VALUES (?,?,?,?,?,?)");
  const join = db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date) VALUES (?,?,?)");
  const chat = db.prepare("INSERT OR IGNORE INTO chat(ROWID,guid) VALUES (?,?)");
  db.transaction(() => {
    for (const message of messages) {
      insert.run(message.rowid, message.guid ?? `${guidPrefix}-${message.rowid}`, `text ${message.rowid}`, message.rowid % 3 === 0 ? null : message.rowid % 5, message.date, message.rowid % 2);
      if (message.chat !== null) {
        chat.run(message.chat, `chat-${message.chat}`);
        join.run(message.chat, message.rowid, message.date);
      }
    }
  })();
}

// `count` messages spread round-robin over `chats` chats, dates rising with ROWID.
function spread(count: number, chats: number, start = 1): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    rowid: start + index,
    chat: ((start + index) % chats) + 1,
    date: BASE_DATE + BigInt(start + index) * 1_000_000_000n,
  }));
}

function setup(messages = spread(60, 40), guidPrefix = "guid") {
  const source = chatDatabase(messages, guidPrefix);
  const directory = path.join(temporaryDirectory(), "cache");
  const file = path.join(directory, `${HASH}.index`);
  return { source, directory, file };
}

const plaintext = Buffer.from("serialized index bytes ".repeat(500), "utf8");

function write(source: Database, file: string, bytes = plaintext): void {
  writeCacheFile({ path: file, plaintext: bytes, source, schemaVersion: SCHEMA, sourceHash: HASH });
}

function read(source: Database, file: string, overrides: { schemaVersion?: number; sourceHash?: string } = {}): Buffer | null {
  return readCacheFile({ path: file, source, schemaVersion: overrides.schemaVersion ?? SCHEMA, sourceHash: overrides.sourceHash ?? HASH });
}

function headerLength(bytes: Buffer): number {
  return PREFIX + bytes.readUInt16BE(46) * 8 + SUFFIX;
}

describe("cache file", () => {
  it("exposes the format constants", () => {
    expect(CACHE_FORMAT_VERSION).toBe(1);
    expect(cacheDirectory().endsWith(path.join("Library", "Caches", "imessage-mcp"))).toBe(true);
    expect(HASH).toMatch(/^[0-9a-f]{32}$/);
    expect(sourceHash("/synthetic/chat.db")).toBe(HASH);
    expect(sourceHash("/synthetic/other.db")).not.toBe(HASH);
  });

  it("round trips the plaintext", () => {
    const { source, file } = setup();
    write(source, file);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 8).toString("latin1")).toBe("IMCACHE1");
    expect(bytes.readUInt16BE(8)).toBe(CACHE_FORMAT_VERSION);
    expect(bytes.readUInt32BE(10)).toBe(SCHEMA);
    expect(bytes.toString("latin1", 14, 46)).toBe(HASH);
    expect(bytes.length).toBe(headerLength(bytes) + plaintext.length + 16);
    expect(bytes.includes(Buffer.from("serialized index"))).toBe(false);
    expect(read(source, file)?.equals(plaintext)).toBe(true);
  });

  it("round trips an empty plaintext", () => {
    const { source, file } = setup();
    write(source, file, Buffer.alloc(0));
    expect(read(source, file)?.length).toBe(0);
  });

  it("uses a fresh salt, nonce and ciphertext on every write", () => {
    const { source, file } = setup();
    write(source, file);
    const first = readFileSync(file);
    write(source, file);
    const second = readFileSync(file);
    const header = headerLength(first);
    const saltAt = header - SUFFIX;
    expect(first.subarray(0, saltAt).equals(second.subarray(0, saltAt))).toBe(true);
    expect(first.subarray(saltAt, saltAt + 32).equals(second.subarray(saltAt, saltAt + 32))).toBe(false);
    expect(first.subarray(saltAt + 32, saltAt + 44).equals(second.subarray(saltAt + 32, saltAt + 44))).toBe(false);
    expect(first.subarray(header).equals(second.subarray(header))).toBe(false);
    expect(read(source, file)?.equals(plaintext)).toBe(true);
  });

  it("cannot be read against a different database with the same shape", () => {
    const { source, file } = setup();
    write(source, file);
    const other = chatDatabase(spread(60, 40), "other");
    expect(sampleAnchors(other)).toEqual(sampleAnchors(source));
    expect(read(other, file)).toBeNull();
  });

  it("becomes unreadable when an anchor row is deleted", () => {
    const { source, file } = setup();
    write(source, file);
    const anchors = sampleAnchors(source);
    source.prepare("DELETE FROM message WHERE ROWID = ?").run(anchors[3]);
    expect(read(source, file)).toBeNull();
  });

  it("becomes unreadable when an anchor row changes", () => {
    const { source, file } = setup();
    write(source, file);
    const anchors = sampleAnchors(source);
    source.prepare("UPDATE message SET date = date + 1 WHERE ROWID = ?").run(anchors[0]);
    expect(read(source, file)).toBeNull();
  });

  it("stays readable after new messages arrive", () => {
    const { source, file } = setup();
    write(source, file);
    addMessages(source, spread(20, 45, 61));
    expect(sampleAnchors(source)).toContain(80);
    expect(read(source, file)?.equals(plaintext)).toBe(true);
  });

  it("stays readable after an unrelated old message is edited", () => {
    const { source, file } = setup();
    write(source, file);
    expect(sampleAnchors(source)).not.toContain(1);
    source.prepare("UPDATE message SET text = 'edited', date = date + 5 WHERE ROWID = 1").run();
    expect(read(source, file)?.equals(plaintext)).toBe(true);
  });

  it("rejects any single flipped byte in the header, ciphertext or tag", () => {
    const { source, file } = setup();
    write(source, file);
    const original = readFileSync(file);
    const header = headerLength(original);
    const positions = new Set<number>([
      0, 7, 8, 9, 10, 13, 14, 45, 46, 47,
      PREFIX, PREFIX + 7, header - SUFFIX - 1,
      header - SUFFIX, header - SUFFIX + 31, header - 20, header - 9, header - 8, header - 1,
      header, header + 1, header + Math.floor(plaintext.length / 2), header + plaintext.length - 1,
      original.length - 16, original.length - 8, original.length - 1,
    ]);
    for (const position of positions) {
      const tampered = Buffer.from(original);
      tampered[position] ^= 0x01;
      writeFileSync(file, tampered);
      expect(read(source, file), `byte ${position}`).toBeNull();
    }
    writeFileSync(file, original);
    expect(read(source, file)?.equals(plaintext)).toBe(true);
  });

  it("returns null on a schema version or source hash mismatch", () => {
    const { source, file } = setup();
    write(source, file);
    expect(read(source, file, { schemaVersion: SCHEMA + 1 })).toBeNull();
    expect(read(source, file, { sourceHash: sourceHash("/elsewhere/chat.db") })).toBeNull();
    expect(read(source, file)?.equals(plaintext)).toBe(true);
  });

  it("returns null for missing, truncated, extended and foreign files", () => {
    const { source, file, directory } = setup();
    expect(read(source, file)).toBeNull();
    write(source, file);
    const original = readFileSync(file);
    for (const length of [0, 5, 47, headerLength(original) - 1, headerLength(original) + 3, original.length - 1]) {
      writeFileSync(file, original);
      truncateSync(file, length);
      expect(read(source, file), `length ${length}`).toBeNull();
    }
    writeFileSync(file, Buffer.concat([original, Buffer.from([0])]));
    expect(read(source, file)).toBeNull();
    writeFileSync(file, Buffer.from("SQLite format 3\0".padEnd(4096, "\0")));
    expect(read(source, file)).toBeNull();
    // An anchor count above the bound.
    const counted = Buffer.from(original);
    counted.writeUInt16BE(257, 46);
    writeFileSync(file, counted);
    expect(read(source, file)).toBeNull();
    // A directory where the file should be.
    rmSync(file);
    mkdirSync(file);
    expect(read(source, file)).toBeNull();
    expect(readdirSync(directory)).toEqual([path.basename(file)]);
  });

  it("returns null when the source database cannot be queried", () => {
    const { source, file } = setup();
    write(source, file);
    source.exec("DROP TABLE message");
    expect(read(source, file)).toBeNull();
  });

  it("creates the directory 0700 and the file 0600, fixing an existing directory", () => {
    const { source, directory, file } = setup();
    write(source, file);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const loose = path.join(temporaryDirectory(), "loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    const looseFile = path.join(loose, "cache.index");
    write(source, looseFile);
    expect(statSync(loose).mode & 0o777).toBe(0o700);
    expect(statSync(looseFile).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary files behind on success or failure", () => {
    const { source, directory, file } = setup();
    write(source, file);
    write(source, file);
    expect(readdirSync(directory)).toEqual([path.basename(file)]);

    // Renaming a file over a non-empty directory fails after the temp file is written.
    const blocked = path.join(directory, "blocked.index");
    mkdirSync(blocked);
    writeFileSync(path.join(blocked, "keep"), "x");
    expect(() => write(source, blocked)).toThrow();
    expect(readdirSync(directory).sort()).toEqual([path.basename(file), "blocked.index"].sort());
  });

  it("refuses to write without anchors or with invalid inputs", () => {
    const { file } = setup();
    const empty = chatDatabase([]);
    expect(() => write(empty, file)).toThrow();
    const { source } = setup();
    expect(() => writeCacheFile({ path: file, plaintext, source, schemaVersion: -1, sourceHash: HASH })).toThrow(RangeError);
    expect(() => writeCacheFile({ path: file, plaintext, source, schemaVersion: SCHEMA, sourceHash: "short" })).toThrow(RangeError);
    expect(() => statSync(file)).toThrow();
  });
});

describe("sampleAnchors", () => {
  it("returns nothing for an empty message table", () => {
    expect(sampleAnchors(chatDatabase([]))).toEqual([]);
  });

  it("returns every row when there are fewer than 32", () => {
    expect(sampleAnchors(chatDatabase(spread(10, 2)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("tops up a single conversation with the newest rows", () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({ rowid: index + 1, chat: 1, date: BASE_DATE + BigInt(index) }));
    expect(sampleAnchors(chatDatabase(messages))).toEqual(Array.from({ length: 32 }, (_, index) => index + 19));
  });

  it("includes messages outside any chat through the newest row", () => {
    const messages: Message[] = [...spread(40, 1), { rowid: 41, chat: null, date: BASE_DATE }];
    const anchors = sampleAnchors(chatDatabase(messages));
    expect(anchors).toHaveLength(32);
    expect(anchors[31]).toBe(41);
    expect(anchors[0]).toBe(10);
  });

  it("samples the newest message of the 32 most recently active of 40 chats plus the newest row", () => {
    // Chat c holds ROWIDs 2c-1 and 2c; chat 1 is the most recently active and
    // chat 40, which holds the newest ROWID, is the least.
    const messages: Message[] = [];
    for (let chat = 1; chat <= 40; chat += 1) {
      for (const offset of [1, 0]) {
        const rowid = 2 * chat - offset;
        messages.push({ rowid, chat, date: BASE_DATE + BigInt((41 - chat) * 1000 + (1 - offset)) });
      }
    }
    const expected = [...Array.from({ length: 32 }, (_, index) => 2 * (index + 1)), 80];
    expect(sampleAnchors(chatDatabase(messages))).toEqual(expected);
  });

  it("orders chats by nanosecond dates that differ only beyond 2^53", () => {
    const messages: Message[] = [];
    for (let chat = 1; chat <= 33; chat += 1) {
      // Dates differ by 1ns, which a double cannot tell apart.
      messages.push({ rowid: chat, chat, date: BASE_DATE + BigInt(chat) });
    }
    // Chat 1 is the least recent, so its row is dropped; chat 33 holds the newest row.
    expect(sampleAnchors(chatDatabase(messages))).toEqual(Array.from({ length: 32 }, (_, index) => index + 2));
  });
});

describe("databaseIdentity", () => {
  it("is stable across appends and differs between archives", () => {
    const first = chatDatabase(spread(40, 5), "alpha");
    const identity = databaseIdentity(first);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    addMessages(first, spread(30, 5, 41), "alpha");
    expect(databaseIdentity(first)).toBe(identity);
    expect(databaseIdentity(chatDatabase(spread(40, 5), "beta"))).not.toBe(identity);
    expect(databaseIdentity(chatDatabase(spread(10, 5), "alpha"))).not.toBe(identity);
  });
});
