// Sidecar FTS5 + lightweight semantic index for accelerated search.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { baseMessageConditions, DATE_EXPR, getActiveProfileId, getDb, getMessageText } from "./db.js";

const INDEX_DIR = process.env.IMESSAGE_INDEX_DIR || path.join(homedir(), ".imessage-mcp", "indexes");
const SEMANTIC_DIMS = 128;

interface IndexMeta {
  last_rowid: number;
  last_indexed_at: string | null;
  last_recent_rowid: number;
  recent_indexed_at: string | null;
}

interface SemanticVectorEntry {
  d: number;
  v: number;
}

export interface SearchIndexHealth {
  profile_id: string;
  index_db_path: string;
  index_exists: boolean;
  indexed_messages: number;
  last_rowid: number;
  source_max_rowid: number;
  pending_rows: number;
  last_indexed_at: string | null;
  recent_indexed_at: string | null;
  pending_recent_rows: number;
}

export interface SearchIndexCandidates {
  backend: "fts5" | "semantic";
  total_matches: number;
  ordered_rowids: number[];
}

export interface SearchFilterContext {
  contact?: string;
  contact_mode?: "auto" | "handle" | "name";
  date_from?: string;
  date_to?: string;
  sent_only?: boolean;
  received_only?: boolean;
  group_chat?: string;
  has_attachment?: boolean;
}

const dbByPath = new Map<string, Database.Database>();

function profileIndexPath(profileId: string): string {
  const safe = profileId.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return path.join(INDEX_DIR, `${safe}.sqlite`);
}

function ensureSchema(indexDb: Database.Database): void {
  indexDb.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_index (
      rowid INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      handle TEXT,
      date TEXT,
      is_from_me INTEGER,
      has_attachment INTEGER,
      semantic TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      text,
      content='message_index',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS message_index_ai AFTER INSERT ON message_index BEGIN
      INSERT INTO message_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS message_index_ad AFTER DELETE ON message_index BEGIN
      INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS message_index_au AFTER UPDATE ON message_index BEGIN
      INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO message_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);

  // Best-effort schema evolution for existing index DBs.
  const addColumn = (sql: string) => {
    try {
      indexDb.exec(sql);
    } catch {
      // Ignore if column already exists.
    }
  };
  addColumn("ALTER TABLE message_index ADD COLUMN is_from_me INTEGER");
  addColumn("ALTER TABLE message_index ADD COLUMN has_attachment INTEGER");
}

function getIndexDb(profileId: string): Database.Database {
  const file = profileIndexPath(profileId);
  const cached = dbByPath.get(file);
  if (cached) return cached;

  mkdirSync(INDEX_DIR, { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  ensureSchema(db);
  dbByPath.set(file, db);
  return db;
}

function getMeta(indexDb: Database.Database): IndexMeta {
  const rows = indexDb.prepare(
    "SELECT key, value FROM metadata WHERE key IN ('last_rowid', 'last_indexed_at', 'last_recent_rowid', 'recent_indexed_at')",
  ).all() as any[];
  let lastRowid = 0;
  let lastIndexedAt: string | null = null;
  let lastRecentRowid = 0;
  let recentIndexedAt: string | null = null;
  for (const row of rows) {
    if (row.key === "last_rowid") lastRowid = Number(row.value) || 0;
    if (row.key === "last_indexed_at") lastIndexedAt = String(row.value);
    if (row.key === "last_recent_rowid") lastRecentRowid = Number(row.value) || 0;
    if (row.key === "recent_indexed_at") recentIndexedAt = String(row.value);
  }
  return {
    last_rowid: lastRowid,
    last_indexed_at: lastIndexedAt,
    last_recent_rowid: lastRecentRowid,
    recent_indexed_at: recentIndexedAt,
  };
}

function setMeta(indexDb: Database.Database, key: string, value: string | number): void {
  indexDb
    .prepare(`
      INSERT INTO metadata(key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    .run({ key, value: String(value) });
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length >= 2);
}

function hashTokenToDim(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % SEMANTIC_DIMS;
}

function encodeSemanticVector(text: string): string {
  const counts = new Map<number, number>();
  for (const token of tokenize(text)) {
    const dim = hashTokenToDim(token);
    counts.set(dim, (counts.get(dim) ?? 0) + 1);
  }

  let norm = 0;
  for (const value of counts.values()) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;

  const sparse: SemanticVectorEntry[] = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, value]) => ({ d, v: value / norm }));

  return JSON.stringify(sparse);
}

function parseSemanticVector(raw: string): Map<number, number> {
  try {
    const parsed = JSON.parse(raw) as SemanticVectorEntry[];
    const map = new Map<number, number>();
    for (const item of parsed) {
      if (typeof item?.d === "number" && typeof item?.v === "number") {
        map.set(item.d, item.v);
      }
    }
    return map;
  } catch {
    return new Map<number, number>();
  }
}

function semanticSimilarity(a: Map<number, number>, b: Map<number, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [d, v] of small) {
    dot += v * (large.get(d) ?? 0);
  }
  return dot;
}

function buildFtsQuery(input: string): string {
  const tokens = tokenize(input).slice(0, 10);
  if (tokens.length === 0) {
    return `"${input.replace(/"/g, '""')}"`;
  }

  return tokens.map((t) => `${t}*`).join(" AND ");
}

export function ensureSearchIndex(input?: {
  profile_id?: string;
  rebuild?: boolean;
  max_rows?: number;
  mode?: "incremental" | "recent";
}): { indexed_rows: number; last_rowid: number; profile_id: string } {
  const profileId = input?.profile_id || getActiveProfileId();
  const indexDb = getIndexDb(profileId);
  const sourceDb = getDb(profileId);
  const mode = input?.mode || "incremental";

  if (input?.rebuild) {
    indexDb.exec(`
      DELETE FROM message_index;
      DELETE FROM message_fts;
      DELETE FROM metadata;
    `);
  }

  const meta = getMeta(indexDb);
  const lastRowid = meta.last_rowid;
  const maxRows = Math.max(1, Math.min(input?.max_rows ?? 20000, 200000));

  const conditions = baseMessageConditions();
  const bindings: Record<string, unknown> = {
    limit: maxRows,
  };

  if (mode === "incremental" && lastRowid > 0) {
    bindings.last_rowid = lastRowid;
    conditions.push("m.ROWID > @last_rowid");
  }

  const rows = sourceDb
    .prepare(`
      SELECT
        m.ROWID as rowid,
        m.text,
        m.attributedBody,
        h.id as handle,
        ${DATE_EXPR} as date,
        m.is_from_me as is_from_me,
        m.cache_has_attachments as has_attachment
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.ROWID ${mode === "recent" ? "DESC" : "ASC"}
      LIMIT @limit
    `)
    .all(bindings) as any[];

  if (rows.length === 0) {
    if (mode === "recent") {
      setMeta(indexDb, "recent_indexed_at", new Date().toISOString());
    } else {
      setMeta(indexDb, "last_indexed_at", new Date().toISOString());
    }
    return {
      indexed_rows: 0,
      last_rowid: lastRowid,
      profile_id: profileId,
    };
  }

  const upsert = indexDb.prepare(`
    INSERT INTO message_index(rowid, text, handle, date, is_from_me, has_attachment, semantic)
    VALUES (@rowid, @text, @handle, @date, @is_from_me, @has_attachment, @semantic)
    ON CONFLICT(rowid) DO UPDATE SET
      text = excluded.text,
      handle = excluded.handle,
      date = excluded.date,
      is_from_me = excluded.is_from_me,
      has_attachment = excluded.has_attachment,
      semantic = excluded.semantic
  `);

  const tx = indexDb.transaction((batch: any[]) => {
    for (const row of batch) {
      const text = getMessageText(row);
      if (!text || !text.trim()) continue;
      upsert.run({
        rowid: row.rowid,
        text,
        handle: row.handle ?? null,
        date: row.date,
        is_from_me: row.is_from_me ?? null,
        has_attachment: row.has_attachment ?? null,
        semantic: encodeSemanticVector(text),
      });
    }
  });

  tx(rows);

  const nowIso = new Date().toISOString();
  const maxIndexedRowid = rows.reduce((max, row) => Math.max(max, Number(row.rowid) || 0), lastRowid);
  if (mode === "recent") {
    setMeta(indexDb, "last_recent_rowid", maxIndexedRowid);
    setMeta(indexDb, "recent_indexed_at", nowIso);
  } else {
    setMeta(indexDb, "last_rowid", maxIndexedRowid);
    setMeta(indexDb, "last_indexed_at", nowIso);
  }

  return {
    indexed_rows: rows.length,
    last_rowid: maxIndexedRowid,
    profile_id: profileId,
  };
}

export function getSearchIndexHealth(profileIdInput?: string): SearchIndexHealth {
  const profileId = profileIdInput || getActiveProfileId();
  const sourceDb = getDb(profileId);
  const sourceMax = ((sourceDb.prepare("SELECT MAX(ROWID) as max_rowid FROM message").get() as any)?.max_rowid ?? 0) as number;

  const indexPath = profileIndexPath(profileId);
  if (!existsSync(indexPath)) {
    return {
      profile_id: profileId,
      index_db_path: indexPath,
      index_exists: false,
      indexed_messages: 0,
      last_rowid: 0,
      source_max_rowid: sourceMax,
      pending_rows: sourceMax,
      last_indexed_at: null,
      recent_indexed_at: null,
      pending_recent_rows: sourceMax,
    };
  }

  const indexDb = getIndexDb(profileId);
  const meta = getMeta(indexDb);
  const count = ((indexDb.prepare("SELECT COUNT(*) as cnt FROM message_index").get() as any)?.cnt ?? 0) as number;

  return {
    profile_id: profileId,
    index_db_path: indexPath,
    index_exists: true,
    indexed_messages: count,
    last_rowid: meta.last_rowid,
    source_max_rowid: sourceMax,
    pending_rows: Math.max(0, sourceMax - meta.last_rowid),
    last_indexed_at: meta.last_indexed_at,
    recent_indexed_at: meta.recent_indexed_at,
    pending_recent_rows: Math.max(0, sourceMax - meta.last_recent_rowid),
  };
}

export function searchIndexCandidates(input: {
  query: string;
  profile_id?: string;
  limit: number;
  offset: number;
  semantic?: boolean;
  rebuild?: boolean;
  filter_context?: SearchFilterContext;
}): SearchIndexCandidates {
  const profileId = input.profile_id || getActiveProfileId();

  // Query-time warmup prioritizes recent rows for freshness.
  ensureSearchIndex({ profile_id: profileId, rebuild: input.rebuild, max_rows: 12000, mode: "recent" });

  const indexDb = getIndexDb(profileId);
  const match = buildFtsQuery(input.query);
  const candidateLimit = Math.max((input.offset + input.limit) * 8, 200);

  const filterSql: string[] = [];
  const filterBindings: Record<string, unknown> = {};
  const filters = input.filter_context;
  if (filters?.date_from) {
    filterSql.push("mi.date >= @f_date_from");
    filterBindings.f_date_from = filters.date_from;
  }
  if (filters?.date_to) {
    filterSql.push("mi.date <= @f_date_to");
    filterBindings.f_date_to = filters.date_to;
  }
  if (filters?.sent_only) {
    filterSql.push("mi.is_from_me = 1");
  }
  if (filters?.received_only) {
    filterSql.push("mi.is_from_me = 0");
  }
  if (filters?.has_attachment) {
    filterSql.push("mi.has_attachment = 1");
  }
  if (filters?.contact && filters.contact_mode !== "name") {
    filterSql.push("mi.handle LIKE @f_contact");
    filterBindings.f_contact = `%${filters.contact}%`;
  }
  const filterClause = filterSql.length > 0 ? ` AND ${filterSql.join(" AND ")}` : "";

  let rows: any[] = [];
  let total = 0;

  try {
    total = ((
      indexDb.prepare(`
        SELECT COUNT(*) as cnt
        FROM message_fts
        JOIN message_index mi ON mi.rowid = message_fts.rowid
        WHERE message_fts MATCH @match ${filterClause}
      `).get({
        match,
        ...filterBindings,
      }) as any
    )?.cnt ?? 0) as number;

    rows = indexDb
      .prepare(
        `SELECT message_fts.rowid as rowid, bm25(message_fts) as rank
         FROM message_fts
         JOIN message_index mi ON mi.rowid = message_fts.rowid
         WHERE message_fts MATCH @match
           ${filterClause}
         ORDER BY rank
         LIMIT @limit`,
      )
      .all({
        match,
        ...filterBindings,
        limit: candidateLimit,
      }) as any[];
  } catch {
    return {
      backend: input.semantic ? "semantic" : "fts5",
      total_matches: 0,
      ordered_rowids: [],
    };
  }

  if (rows.length === 0) {
    return {
      backend: input.semantic ? "semantic" : "fts5",
      total_matches: total,
      ordered_rowids: [],
    };
  }

  if (!input.semantic) {
    const ordered = rows.map((r) => r.rowid).slice(input.offset, input.offset + input.limit);
    return {
      backend: "fts5",
      total_matches: total,
      ordered_rowids: ordered,
    };
  }

  const queryVec = parseSemanticVector(encodeSemanticVector(input.query));
  const idPlaceholders = rows.map((_, i) => `@id${i}`).join(",");
  const bindings: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    bindings[`id${i}`] = row.rowid;
  });

  const semanticRows = indexDb
    .prepare(`
      SELECT rowid, semantic
      FROM message_index
      WHERE rowid IN (${idPlaceholders})
    `)
    .all(bindings) as any[];

  const semanticByRowid = new Map<number, number>();
  for (const row of semanticRows) {
    semanticByRowid.set(row.rowid, semanticSimilarity(queryVec, parseSemanticVector(row.semantic)));
  }

  const ranked = rows
    .map((row) => {
      const lexical = 1 / (1 + Math.max(0, Number(row.rank) || 0));
      const semantic = semanticByRowid.get(row.rowid) ?? 0;
      const score = (lexical * 0.35) + (semantic * 0.65);
      return {
        rowid: row.rowid,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(input.offset, input.offset + input.limit);

  return {
    backend: "semantic",
    total_matches: total,
    ordered_rowids: ranked.map((r) => r.rowid),
  };
}
