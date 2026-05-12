// Persistent cursor store for incremental tools.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getRequestContext } from "./context.js";

interface CursorState {
  version: 1;
  updated_at: string;
  cursors: Record<string, number>;
}

const DEFAULT_CURSOR_FILE = join(homedir(), ".imessage-mcp", "cursors.json");
let cachedState: CursorState | null = null;

function cursorFilePath(): string {
  return process.env.IMESSAGE_CURSOR_FILE || DEFAULT_CURSOR_FILE;
}

function ensureDir(): void {
  mkdirSync(dirname(cursorFilePath()), { recursive: true });
}

function defaultState(): CursorState {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    cursors: {},
  };
}

function loadState(): CursorState {
  if (cachedState) return cachedState;

  const file = cursorFilePath();
  if (!existsSync(file)) {
    cachedState = defaultState();
    return cachedState;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as CursorState;
    if (!parsed || parsed.version !== 1 || typeof parsed.cursors !== "object") {
      cachedState = defaultState();
      return cachedState;
    }
    cachedState = parsed;
    return cachedState;
  } catch {
    cachedState = defaultState();
    return cachedState;
  }
}

function writeState(state: CursorState): void {
  ensureDir();
  const file = cursorFilePath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, file);
  try {
    unlinkSync(`${file}.bak`);
  } catch {
    // no-op
  }
}

function scopedNamespace(namespace: string): string {
  const ctx = getRequestContext();
  if (!ctx) return namespace;

  const subject = ctx.principal?.subject ?? "anonymous";
  return `profile:${ctx.profile_id}|subject:${subject}|${namespace}`;
}

export function getCursor(namespace: string): number | null {
  const state = loadState();
  const key = scopedNamespace(namespace);
  const value = state.cursors[key];
  return typeof value === "number" ? value : null;
}

export function setCursor(namespace: string, rowid: number): void {
  const state = loadState();
  const key = scopedNamespace(namespace);
  state.cursors[key] = rowid;
  state.updated_at = new Date().toISOString();
  writeState(state);
}

export function resetCursor(namespace: string): void {
  const state = loadState();
  const key = scopedNamespace(namespace);
  delete state.cursors[key];
  state.updated_at = new Date().toISOString();
  writeState(state);
}

export function listCursors(): Record<string, number> {
  const raw = loadState().cursors;
  const ctx = getRequestContext();
  if (!ctx) return { ...raw };

  const subject = ctx.principal?.subject ?? "anonymous";
  const prefix = `profile:${ctx.profile_id}|subject:${subject}|`;
  const scoped: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(prefix)) {
      scoped[key.slice(prefix.length)] = value;
    }
  }
  return scoped;
}
