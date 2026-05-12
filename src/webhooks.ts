// Webhook subscription store + event replay/delivery bus.

import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import net from "node:net";
import { getRequestContext, isAdminPrincipal } from "./context.js";
import { safeText } from "./db.js";
import { getProfileIds, resolveAllowedProfileId } from "./profiles.js";

export interface WebhookMessageSummary {
  rowid: number;
  date: string;
  is_from_me: number;
  handle: string | null;
  contact_name: string | null;
  chat_id?: string | null;
  group_name?: string | null;
  text?: string | null;
}

export interface WebhookEventData {
  count: number;
  cursor_after_rowid: number;
  senders: string[];
  messages: WebhookMessageSummary[];
}

export interface WebhookEvent {
  id: string;
  type: "messages.created";
  profile_id: string;
  created_at: string;
  data: WebhookEventData;
}

interface EventLogV2Record {
  version: 2;
  seq: number;
  event: WebhookEvent;
}

export interface WebhookSubscription {
  id: string;
  owner_subject: string;
  profile_id: string;
  url: string;
  secret: string;
  enabled: boolean;
  events: string[];
  include_text: boolean;
  filter_contact_contains?: string;
  filter_keyword_any?: string[];
  created_at: string;
  updated_at: string;
  last_delivery_at?: string;
  last_delivery_status?: number;
  last_error?: string;
  failure_count: number;
}

interface WebhookState {
  version: 2;
  subscriptions: Record<string, WebhookSubscription>;
  next_seq: number;
}

interface ActorIdentity {
  subject: string;
  is_admin: boolean;
  profile_id: string;
  allowed_profiles: string[];
}

const DEFAULT_WEBHOOK_STATE_FILE = join(homedir(), ".imessage-mcp", "webhooks.json");
const DEFAULT_EVENT_LOG_FILE = join(homedir(), ".imessage-mcp", "event-log.jsonl");

const WEBHOOK_TIMEOUT_MS = parseInt(process.env.IMESSAGE_WEBHOOK_TIMEOUT_MS ?? "10000", 10) || 10000;
const WEBHOOK_MAX_RETRIES = parseInt(process.env.IMESSAGE_WEBHOOK_MAX_RETRIES ?? "3", 10) || 3;
const WEBHOOK_DELIVERY_CONCURRENCY = Math.max(1, parseInt(process.env.IMESSAGE_WEBHOOK_DELIVERY_CONCURRENCY ?? "4", 10) || 4);
const WEBHOOK_DISABLE_AFTER_FAILURES = Math.max(1, parseInt(process.env.IMESSAGE_WEBHOOK_DISABLE_AFTER_FAILURES ?? "10", 10) || 10);
const WEBHOOK_ALLOWED_HOSTS = parseCsv(process.env.IMESSAGE_WEBHOOK_ALLOWED_HOSTS);
const WEBHOOK_ALLOW_PRIVATE_IPS = (process.env.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS ?? "false").toLowerCase() === "true";
const EVENT_LOG_TEXT_MODE = parseEventLogTextMode(process.env.IMESSAGE_EVENT_LOG_TEXT_MODE);

let cachedState: WebhookState | null = null;

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function parseEventLogTextMode(raw: string | undefined): "full" | "redacted" | "none" {
  const value = (raw || "full").toLowerCase();
  if (value === "full" || value === "redacted" || value === "none") return value;
  return "full";
}

function webhookStatePath(): string {
  return process.env.IMESSAGE_WEBHOOK_STATE_FILE || DEFAULT_WEBHOOK_STATE_FILE;
}

function eventLogPath(): string {
  return process.env.IMESSAGE_EVENT_LOG_FILE || DEFAULT_EVENT_LOG_FILE;
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function defaultState(): WebhookState {
  return {
    version: 2,
    subscriptions: {},
    next_seq: 1,
  };
}

function detectNextSeqFromEventLogSync(): number {
  const file = eventLogPath();
  if (!existsSync(file)) return 1;
  try {
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) return 1;
    let max = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          if (parsed.version === 2 && Number.isFinite(parsed.seq)) {
            max = Math.max(max, Number(parsed.seq));
            continue;
          }
          if (Number.isFinite((parsed as any).seq)) {
            max = Math.max(max, Number((parsed as any).seq));
          } else if ((parsed as any).id && (parsed as any).type) {
            max += 1;
          }
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

function loadState(): WebhookState {
  if (cachedState) return cachedState;

  const file = webhookStatePath();
  if (!existsSync(file)) {
    cachedState = defaultState();
    return cachedState;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as any;
    if (!parsed || typeof parsed !== "object") {
      cachedState = defaultState();
      return cachedState;
    }

    if (parsed.version === 2 && typeof parsed.subscriptions === "object") {
      const detectedNext = detectNextSeqFromEventLogSync();
      cachedState = {
        version: 2,
        subscriptions: parsed.subscriptions || {},
        next_seq: Number.isFinite(parsed.next_seq)
          ? Math.max(1, Number(parsed.next_seq), detectedNext)
          : detectedNext,
      };
      return cachedState;
    }

    // v1 migration
    cachedState = {
      version: 2,
      subscriptions: parsed.subscriptions || {},
      next_seq: detectNextSeqFromEventLogSync(),
    };
    saveState(cachedState);
    return cachedState;
  } catch {
    cachedState = defaultState();
    return cachedState;
  }
}

function saveState(state: WebhookState): void {
  const file = webhookStatePath();
  ensureDir(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, file);
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function randomTokenHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

function actorIdentity(): ActorIdentity {
  const ctx = getRequestContext();
  if (!ctx?.principal) {
    const allProfiles = getProfileIds();
    return {
      subject: "local",
      is_admin: true,
      profile_id: ctx?.profile_id || allProfiles[0] || "default",
      allowed_profiles: allProfiles,
    };
  }

  const principal = ctx.principal;
  return {
    subject: principal.subject,
    is_admin: isAdminPrincipal(principal),
    profile_id: ctx.profile_id,
    allowed_profiles: principal.allowed_profiles,
  };
}

function normalizeEvents(events: string[] | undefined): WebhookEvent["type"][] {
  const allowed = new Set<WebhookEvent["type"]>(["messages.created"]);
  const normalized = (events || ["messages.created"])
    .map((evt) => evt.trim())
    .filter(Boolean);

  if (normalized.length === 0) return ["messages.created"];
  const invalid = normalized.find((evt) => !allowed.has(evt as WebhookEvent["type"]));
  if (invalid) {
    throw new Error(`Unsupported webhook event: ${invalid}`);
  }
  return [...new Set(normalized)] as WebhookEvent["type"][];
}

function sanitizeKeywordFilters(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const cleaned = values
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function messageContainsKeyword(msg: WebhookMessageSummary, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;
  const text = (msg.text || "").toLowerCase();
  if (!text) return false;
  return keywords.some((k) => text.includes(k));
}

function messageMatchesContact(msg: WebhookMessageSummary, contactContains?: string): boolean {
  if (!contactContains) return true;
  const needle = contactContains.toLowerCase();
  const values = [msg.handle || "", msg.contact_name || "", msg.group_name || ""];
  return values.some((v) => v.toLowerCase().includes(needle));
}

function subscriptionMatchesEvent(sub: WebhookSubscription, event: WebhookEvent): boolean {
  if (!sub.enabled) return false;
  if (!sub.events.includes(event.type)) return false;
  if (sub.profile_id !== event.profile_id) return false;

  if (!sub.filter_contact_contains && (!sub.filter_keyword_any || sub.filter_keyword_any.length === 0)) {
    return true;
  }

  return event.data.messages.some((msg) => {
    return messageMatchesContact(msg, sub.filter_contact_contains)
      && messageContainsKeyword(msg, sub.filter_keyword_any);
  });
}

function buildDeliveryPayload(sub: WebhookSubscription, event: WebhookEvent): WebhookEvent {
  if (sub.include_text) {
    return {
      ...event,
      data: {
        ...event.data,
        messages: event.data.messages.map((msg) => ({
          ...msg,
          text: safeText(msg.text ?? null),
        })),
      },
    };
  }

  return {
    ...event,
    data: {
      ...event.data,
      messages: event.data.messages.map((msg) => {
        const { text: _text, ...rest } = msg;
        return rest;
      }) as WebhookMessageSummary[],
    },
  };
}

function signatureForPayload(secret: string, timestamp: string, payload: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) >>> 0) + ((nums[1] << 16) >>> 0) + ((nums[2] << 8) >>> 0) + nums[3];
}

function inRange(ip: string, cidr: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const baseInt = ipv4ToInt(base);
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isPrivateOrReservedIp(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    return [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ].some((cidr) => inRange(address, cidr));
  }

  if (ipVersion === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("::ffff:127.")) return true;
  }

  return false;
}

function hostAllowedByConfig(hostname: string): boolean {
  if (WEBHOOK_ALLOWED_HOSTS.length === 0) return true;
  const lower = hostname.toLowerCase();
  return WEBHOOK_ALLOWED_HOSTS.some((allowed) => {
    if (allowed === "*") return true;
    if (allowed.startsWith("*.")) {
      return lower.endsWith(allowed.slice(1));
    }
    return lower === allowed;
  });
}

async function validateWebhookTarget(urlRaw: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    throw new Error("Webhook url must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Webhook url must start with http:// or https://");
  }

  if (!hostAllowedByConfig(parsed.hostname)) {
    throw new Error("Webhook target host is not allowlisted");
  }

  if (WEBHOOK_ALLOW_PRIVATE_IPS) return;

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("Webhook target resolves to loopback/private address; set IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS=true to override");
  }

  const ipVersion = net.isIP(parsed.hostname);
  if (ipVersion > 0) {
    if (isPrivateOrReservedIp(parsed.hostname)) {
      throw new Error("Webhook target uses private/reserved IP; set IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS=true to override");
    }
    return;
  }

  const resolved = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error("Webhook target hostname did not resolve");
  }
  const privateHit = resolved.find((entry) => isPrivateOrReservedIp(entry.address));
  if (privateHit) {
    throw new Error("Webhook target resolves to private/reserved IP; set IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS=true to override");
  }
}

function withEventLogTextPolicy(event: WebhookEvent): WebhookEvent {
  if (EVENT_LOG_TEXT_MODE === "full") return event;
  if (EVENT_LOG_TEXT_MODE === "redacted") {
    return {
      ...event,
      data: {
        ...event.data,
        messages: event.data.messages.map((msg) => ({
          ...msg,
          text: safeText(msg.text ?? null),
        })),
      },
    };
  }

  return {
    ...event,
    data: {
      ...event.data,
      messages: event.data.messages.map((msg) => {
        const { text: _text, ...rest } = msg;
        return rest;
      }) as WebhookMessageSummary[],
    },
  };
}

function appendEventLog(state: WebhookState, event: WebhookEvent): number {
  const file = eventLogPath();
  ensureDir(file);

  const seq = state.next_seq;
  state.next_seq += 1;

  const record: EventLogV2Record = {
    version: 2,
    seq,
    event: withEventLogTextPolicy(event),
  };
  writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf-8", flag: "a" });
  return seq;
}

async function* iterateLoggedEvents(): AsyncGenerator<{ seq: number; event: WebhookEvent }> {
  const file = eventLogPath();
  if (!existsSync(file)) return;

  const input = createReadStream(file, { encoding: "utf-8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let fallbackSeq = 0;

  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.version === 2 && Number.isFinite(parsed.seq) && parsed.event?.id) {
        yield { seq: Number(parsed.seq), event: parsed.event as WebhookEvent };
        continue;
      }

      const eventLike = parsed as WebhookEvent & { seq?: number };
      if (eventLike?.id && eventLike?.type) {
        const seq = Number.isFinite(eventLike.seq) ? Number(eventLike.seq) : ++fallbackSeq;
        yield { seq, event: eventLike };
      }
    } catch {
      // Skip malformed lines.
    }
  }
}

async function findSeqForEventId(eventId: string): Promise<number | null> {
  let found: number | null = null;
  for await (const entry of iterateLoggedEvents()) {
    if (entry.event.id === eventId) {
      found = entry.seq;
    }
  }
  return found;
}

function canAccessSubscription(sub: WebhookSubscription, actor: ActorIdentity): boolean {
  if (actor.is_admin) return true;
  if (sub.owner_subject !== actor.subject) return false;
  if (actor.allowed_profiles.includes("*")) return true;
  return actor.allowed_profiles.includes(sub.profile_id);
}

async function deliverToSubscription(sub: WebhookSubscription, event: WebhookEvent): Promise<boolean> {
  const payload = buildDeliveryPayload(sub, event);
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signatureForPayload(sub.secret, timestamp, body);

  let lastStatus = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const response = await fetch(sub.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "imessage-mcp-webhook/1.0",
          "X-iMessage-Event": event.type,
          "X-iMessage-Event-Id": event.id,
          "X-iMessage-Sequence": String((event as any).seq ?? ""),
          "X-iMessage-Timestamp": timestamp,
          "X-iMessage-Signature-256": signature,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      lastStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        sub.last_delivery_at = new Date().toISOString();
        sub.last_delivery_status = response.status;
        sub.last_error = undefined;
        sub.failure_count = 0;
        sub.updated_at = new Date().toISOString();
        return true;
      }

      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < WEBHOOK_MAX_RETRIES) {
      await sleep(250 * (2 ** (attempt - 1)));
    }
  }

  sub.failure_count += 1;
  sub.last_error = lastError;
  sub.last_delivery_status = lastStatus || undefined;
  sub.updated_at = new Date().toISOString();
  if (WEBHOOK_DISABLE_AFTER_FAILURES > 0 && sub.failure_count >= WEBHOOK_DISABLE_AFTER_FAILURES) {
    sub.enabled = false;
  }
  return false;
}

async function deliverWithConcurrency(subscriptions: WebhookSubscription[], event: WebhookEvent): Promise<void> {
  if (subscriptions.length === 0) return;
  const queue = [...subscriptions];
  const workers = Array.from({ length: Math.min(WEBHOOK_DELIVERY_CONCURRENCY, queue.length) }, async () => {
    while (true) {
      const next = queue.shift();
      if (!next) return;
      await deliverToSubscription(next, event);
    }
  });
  await Promise.all(workers);
}

export async function createWebhookSubscription(input: {
  url: string;
  events?: string[];
  include_text?: boolean;
  enabled?: boolean;
  secret?: string;
  profile_id?: string;
  filter_contact_contains?: string;
  filter_keyword_any?: string[];
}): Promise<{ subscription: WebhookSubscription; generated_secret?: string }> {
  const actor = actorIdentity();
  const state = loadState();

  const url = input.url.trim();
  await validateWebhookTarget(url);

  const profileId = resolveAllowedProfileId(
    input.profile_id?.trim() || actor.profile_id,
    actor.is_admin ? undefined : actor.allowed_profiles,
  );

  const id = randomId("sub");
  const generatedSecret = input.secret?.trim() || randomTokenHex(24);

  const sub: WebhookSubscription = {
    id,
    owner_subject: actor.subject,
    profile_id: profileId,
    url,
    secret: generatedSecret,
    enabled: input.enabled ?? true,
    events: normalizeEvents(input.events),
    include_text: Boolean(input.include_text),
    filter_contact_contains: input.filter_contact_contains?.trim() || undefined,
    filter_keyword_any: sanitizeKeywordFilters(input.filter_keyword_any),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    failure_count: 0,
  };

  state.subscriptions[id] = sub;
  saveState(state);

  return {
    subscription: sub,
    generated_secret: input.secret ? undefined : generatedSecret,
  };
}

export function listWebhookSubscriptions(input?: { profile_id?: string; include_all?: boolean }): WebhookSubscription[] {
  const actor = actorIdentity();
  const state = loadState();

  const requestedProfile = input?.profile_id
    ? resolveAllowedProfileId(input.profile_id.trim(), actor.is_admin ? undefined : actor.allowed_profiles)
    : undefined;

  return Object.values(state.subscriptions)
    .filter((sub) => {
      if (!input?.include_all && !sub.enabled) return false;
      if (requestedProfile && sub.profile_id !== requestedProfile) return false;
      return canAccessSubscription(sub, actor);
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function deleteWebhookSubscription(id: string): boolean {
  const actor = actorIdentity();
  const state = loadState();
  const sub = state.subscriptions[id];
  if (!sub) return false;

  if (!canAccessSubscription(sub, actor)) {
    throw new Error("Not authorized to delete this subscription");
  }

  delete state.subscriptions[id];
  saveState(state);
  return true;
}

export async function replayWebhookSubscription(input: {
  id: string;
  since_seq?: number;
  since_rowid?: number;
  since_event_id?: string;
  limit?: number;
}): Promise<{ delivered: number; attempted: number; replayed_events: number; last_seq?: number }> {
  const actor = actorIdentity();
  const state = loadState();
  const sub = state.subscriptions[input.id];
  if (!sub) throw new Error(`Unknown subscription: ${input.id}`);

  if (!canAccessSubscription(sub, actor)) {
    throw new Error("Not authorized to replay this subscription");
  }

  let effectiveSinceSeq = Number.isFinite(input.since_seq) ? Math.max(0, Number(input.since_seq)) : 0;
  let legacySinceEventId: string | null = null;
  if (!effectiveSinceSeq && input.since_event_id) {
    const resolved = await findSeqForEventId(input.since_event_id);
    if (resolved !== null) {
      effectiveSinceSeq = resolved;
    } else {
      legacySinceEventId = input.since_event_id;
    }
  }

  const limit = Math.max(1, Math.min(input.limit ?? 200, 5000));
  let replayedEvents = 0;
  let attempted = 0;
  let delivered = 0;
  let lastSeq: number | undefined;

  for await (const entry of iterateLoggedEvents()) {
    if (entry.seq <= effectiveSinceSeq) continue;
    if (legacySinceEventId && entry.event.id <= legacySinceEventId) continue;
    if (entry.event.profile_id !== sub.profile_id || entry.event.type !== "messages.created") continue;
    if (input.since_rowid && entry.event.data.cursor_after_rowid <= input.since_rowid) continue;

    replayedEvents += 1;
    lastSeq = entry.seq;
    if (subscriptionMatchesEvent(sub, entry.event)) {
      attempted += 1;
      const payloadEvent = { ...entry.event, seq: entry.seq } as WebhookEvent;
      const ok = await deliverToSubscription(sub, payloadEvent);
      if (ok) delivered += 1;
    }
    if (replayedEvents >= limit) break;
  }

  saveState(state);
  return { delivered, attempted, replayed_events: replayedEvents, last_seq: lastSeq };
}

export async function publishWebhookEvent(event: WebhookEvent): Promise<void> {
  const state = loadState();
  const seq = appendEventLog(state, event);

  const enriched = { ...event, seq } as WebhookEvent;
  const targets = Object.values(state.subscriptions).filter((sub) => subscriptionMatchesEvent(sub, event));
  await deliverWithConcurrency(targets, enriched);

  saveState(state);
}

export function getWebhookRuntimeSummary(): {
  state_file: string;
  event_log_file: string;
  subscription_count: number;
  enabled_count: number;
  delivery_concurrency: number;
  disable_after_failures: number;
  text_mode: "full" | "redacted" | "none";
  private_ips_allowed: boolean;
} {
  const state = loadState();
  const subs = Object.values(state.subscriptions);
  return {
    state_file: webhookStatePath(),
    event_log_file: eventLogPath(),
    subscription_count: subs.length,
    enabled_count: subs.filter((s) => s.enabled).length,
    delivery_concurrency: WEBHOOK_DELIVERY_CONCURRENCY,
    disable_after_failures: WEBHOOK_DISABLE_AFTER_FAILURES,
    text_mode: EVENT_LOG_TEXT_MODE,
    private_ips_allowed: WEBHOOK_ALLOW_PRIVATE_IPS,
  };
}

// Test helper to reset in-memory cache between test cases.
export function resetWebhookStateForTests(): void {
  cachedState = null;
}
