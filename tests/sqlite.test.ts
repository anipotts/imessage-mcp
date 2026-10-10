import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "../src/sqlite.js";

describe("sqlite iterator lifetime", () => {
  let directory: string;
  let reader: Database;
  let writer: Database;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "imessage-sqlite-iterator-"));
    const file = path.join(directory, "synthetic.db");
    writer = new Database(file);
    writer.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1),(2)");
    reader = new Database(file, { readonly: true });
  });

  afterEach(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const writeAfterScan = () => expect(() => writer.prepare("INSERT INTO sample VALUES(3)").run()).not.toThrow();

  it("releases the native read lock when a consumer breaks early", () => {
    for (const item of reader.prepare("SELECT id FROM sample").iterate()) {
      expect(item).toEqual({ id: 1 });
      break;
    }
    writeAfterScan();
  });

  it("releases the native read lock when the consumer throws", () => {
    expect(() => {
      for (const item of reader.prepare("SELECT id FROM sample").iterate()) {
        expect(item).toEqual({ id: 1 });
        throw new Error("synthetic validation failure");
      }
    }).toThrow("synthetic validation failure");
    writeAfterScan();
  });

  it("releases the native read lock when the caller returns the iterator", () => {
    const iterator = reader.prepare("SELECT id FROM sample").iterate();
    expect(iterator.next().done).toBe(false);
    iterator.return?.();
    writeAfterScan();
  });
});
