// Evidence bundle generation helpers used by MCP tools and CLI exports.

import { createHash } from "node:crypto";
import { getDb, DATE_EXPR, baseMessageConditions, getMessageText, safeText } from "./db.js";
import { lookupContact } from "./contacts.js";
import { applyContactFilter, type ContactMode } from "./contact-filter.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT } from "./helpers.js";

export interface EvidenceBundleParams {
  contact?: string;
  contact_mode?: ContactMode;
  date_from?: string;
  date_to?: string;
  since_rowid?: number;
  limit?: number;
  include_text?: boolean;
  include_attachments?: boolean;
}

export interface EvidenceRecord {
  rowid: number;
  guid: string | null;
  date: string;
  is_from_me: number;
  handle: string | null;
  contact_name: string | null;
  text: string | null;
  has_attachment: number;
  service: string | null;
}

export interface EvidenceBundle {
  schema_version: string;
  generated_at: string;
  filters: EvidenceBundleParams;
  record_count: number;
  records: EvidenceRecord[];
  checksums: {
    algorithm: "sha256";
    records: Array<{ rowid: number; hash: string }>;
    manifest_hash: string;
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function csvEscape(value: unknown): string {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

export function recordsToCsv(records: EvidenceRecord[]): string {
  const headers = [
    "rowid",
    "guid",
    "date",
    "is_from_me",
    "handle",
    "contact_name",
    "text",
    "has_attachment",
    "service",
  ];
  const lines = [headers.join(",")];
  for (const row of records) {
    lines.push([
      csvEscape(row.rowid),
      csvEscape(row.guid),
      csvEscape(row.date),
      csvEscape(row.is_from_me),
      csvEscape(row.handle),
      csvEscape(row.contact_name),
      csvEscape(row.text),
      csvEscape(row.has_attachment),
      csvEscape(row.service),
    ].join(","));
  }
  return lines.join("\n");
}

export function buildEvidenceBundle(params: EvidenceBundleParams): EvidenceBundle {
  const db = getDb();
  const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);

  const conditions = baseMessageConditions();
  const bindings: Record<string, unknown> = {};

  applyContactFilter(conditions, bindings, {
    contact: params.contact,
    contact_mode: params.contact_mode,
    alias: "h.id",
    prefix: "ev_contact",
  });

  if (params.date_from) {
    conditions.push(`${DATE_EXPR} >= @date_from`);
    bindings.date_from = params.date_from;
  }
  if (params.date_to) {
    conditions.push(`${DATE_EXPR} <= @date_to`);
    bindings.date_to = params.date_to;
  }
  if (params.since_rowid !== undefined) {
    conditions.push("m.ROWID > @since_rowid");
    bindings.since_rowid = params.since_rowid;
  }

  const where = conditions.join(" AND ");

  const rows = db.prepare(`
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.attributedBody,
      m.is_from_me,
      ${DATE_EXPR} as date,
      h.id as handle,
      m.cache_has_attachments as has_attachment,
      m.service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT @limit
  `).all({ ...bindings, limit }) as any[];

  const records: EvidenceRecord[] = rows.map((row: any) => {
    const contact = row.handle ? lookupContact(row.handle) : null;
    return {
      rowid: row.rowid,
      guid: row.guid ?? null,
      date: row.date,
      is_from_me: row.is_from_me,
      handle: row.handle ?? null,
      contact_name: contact?.name ?? null,
      text: params.include_text ? safeText(getMessageText(row)) : null,
      has_attachment: row.has_attachment ?? 0,
      service: row.service ?? null,
    };
  });

  const recordHashes = records.map((record) => ({
    rowid: record.rowid,
    hash: sha256(canonical(record)),
  }));

  const manifestHash = sha256(canonical({
    generated_at: new Date().toISOString(),
    filters: params,
    record_count: records.length,
    record_hashes: recordHashes,
  }));

  return {
    schema_version: "2026-02-25.1",
    generated_at: new Date().toISOString(),
    filters: params,
    record_count: records.length,
    records,
    checksums: {
      algorithm: "sha256",
      records: recordHashes,
      manifest_hash: manifestHash,
    },
  };
}
