// SQLite through node's built-in node:sqlite, with the small synchronous
// surface this server uses: prepared statements, pragmas, scalar functions,
// nested transactions and serialize. Blobs come back as Buffers, integers
// beyond 2^53 are exact only through safeIntegers(), and errors carry the
// SQLite result name in `code` (SQLITE_FULL, SQLITE_CONSTRAINT_UNIQUE).

import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Params = unknown[];

const RESULT_NAMES = new Map<number, string>([
  [5, "SQLITE_BUSY"],
  [8, "SQLITE_READONLY"],
  [11, "SQLITE_CORRUPT"],
  [13, "SQLITE_FULL"],
  [14, "SQLITE_CANTOPEN"],
  [19, "SQLITE_CONSTRAINT"],
  [26, "SQLITE_NOTADB"],
  [1555, "SQLITE_CONSTRAINT_PRIMARYKEY"],
  [2067, "SQLITE_CONSTRAINT_UNIQUE"],
]);

function named(error: unknown): unknown {
  if (error && typeof error === "object" && typeof (error as { errcode?: unknown }).errcode === "number") {
    const errcode = (error as { errcode: number }).errcode;
    const code = RESULT_NAMES.get(errcode) ?? RESULT_NAMES.get(errcode & 0xff) ?? "SQLITE_ERROR";
    try {
      Object.defineProperty(error, "code", { value: code, configurable: true, writable: true });
    } catch {
      // leave the original code in place
    }
  }
  return error;
}

function guard<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw named(error);
  }
}

function value(raw: unknown, exact: boolean): unknown {
  if (typeof raw === "bigint") return exact ? raw : Number(raw);
  if (raw instanceof Uint8Array && !Buffer.isBuffer(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return raw;
}

function row(raw: unknown, exact: boolean): unknown {
  if (Array.isArray(raw)) return raw.map((item) => value(item, exact));
  if (raw && typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(raw)) out[key] = value(item, exact);
    return out;
  }
  return raw;
}

export class Statement {
  private exact = false;
  private plucked = false;

  constructor(private readonly statement: StatementSync) {
    statement.setReadBigInts(true);
    statement.setAllowUnknownNamedParameters(true);
  }

  raw(enabled = true): this {
    this.statement.setReturnArrays(enabled);
    return this;
  }

  // Returns the first column of each row instead of the row.
  pluck(enabled = true): this {
    this.plucked = enabled;
    if (enabled) this.statement.setReturnArrays(true);
    return this;
  }

  safeIntegers(enabled = true): this {
    this.exact = enabled;
    return this;
  }

  get(...params: Params): unknown {
    return guard(() => {
      const result = this.statement.get(...(params as never[]));
      if (result === undefined) return undefined;
      const converted = row(result, this.exact);
      return this.plucked ? (converted as unknown[])[0] : converted;
    });
  }

  all(...params: Params): unknown[] {
    return guard(() => this.statement.all(...(params as never[])).map((item) => {
      const converted = row(item, this.exact);
      return this.plucked ? (converted as unknown[])[0] : converted;
    }));
  }

  run(...params: Params): { changes: number; lastInsertRowid: number | bigint } {
    return guard(() => {
      const result = this.statement.run(...(params as never[]));
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    });
  }

  *iterate(...params: Params): IterableIterator<unknown> {
    let iterator: Iterator<unknown>;
    try {
      iterator = this.statement.iterate(...(params as never[]));
    } catch (error) {
      throw named(error);
    }
    for (;;) {
      let next: IteratorResult<unknown>;
      try {
        next = iterator.next();
      } catch (error) {
        throw named(error);
      }
      if (next.done) return;
      const converted = row(next.value, this.exact);
      yield this.plucked ? (converted as unknown[])[0] : converted;
    }
  }
}

let savepoints = 0;

class Database {
  private readonly db: DatabaseSync;

  constructor(location: string, options: { readonly?: boolean; fileMustExist?: boolean } = {}) {
    if (options.fileMustExist && location !== ":memory:" && !existsSync(location)) {
      throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN", errcode: 14 });
    }
    this.db = guard(() => new DatabaseSync(location, { readOnly: options.readonly === true }));
  }

  get open(): boolean {
    return this.db.isOpen;
  }

  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  prepare(sql: string): Statement {
    return new Statement(guard(() => this.db.prepare(sql)));
  }

  exec(sql: string): this {
    guard(() => this.db.exec(sql));
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.prepare(`PRAGMA ${source}`).all() as Array<Record<string, unknown>>;
    if (!options.simple) return rows;
    const first = rows[0];
    return first === undefined ? undefined : Object.values(first)[0];
  }

  function(name: string, options: { deterministic?: boolean } | ((...args: never[]) => unknown), implementation?: (...args: never[]) => unknown): this {
    const fn = typeof options === "function" ? options : implementation;
    if (!fn) throw new TypeError("function implementation is required");
    const deterministic = typeof options === "object" && options.deterministic === true;
    guard(() => this.db.function(name, { deterministic, useBigIntArguments: false, varargs: true }, (...args: unknown[]) => {
      const converted = args.map((arg) => (arg instanceof Uint8Array && !Buffer.isBuffer(arg) ? Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength) : arg));
      const result = (fn as (...values: unknown[]) => unknown)(...converted);
      return typeof result === "boolean" ? (result ? 1 : 0) : result as never;
    }));
    return this;
  }

  // A transaction function: nested calls become savepoints, like better-sqlite3.
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return ((...args: Parameters<T>) => {
      if (this.db.isTransaction) {
        const name = `sp_${++savepoints}`;
        this.exec(`SAVEPOINT ${name}`);
        try {
          const result = fn(...args);
          this.exec(`RELEASE ${name}`);
          return result;
        } catch (error) {
          this.exec(`ROLLBACK TO ${name}`);
          this.exec(`RELEASE ${name}`);
          throw error;
        }
      }
      this.exec("BEGIN");
      try {
        const result = fn(...args);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.db.isTransaction) this.exec("ROLLBACK");
        throw error;
      }
    }) as T;
  }

  serialize(): Buffer {
    const bytes = guard(() => this.db.serialize());
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  deserialize(bytes: Uint8Array): void {
    guard(() => this.db.deserialize(bytes));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Database {
  type Database = InstanceType<typeof Database>;
}

export default Database;
