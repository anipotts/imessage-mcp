import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RuntimeConfig } from "./config.js";
import { API_VERSION, type PrivacyMode, type ServiceFamily } from "./contracts.js";
import { looksLikeHandle, normalizeHandle, UnifiedContactResolver, type ContactResolution } from "./contacts.js";
import { DatabaseContext, watermarkToken, type DatabaseRequest } from "./database.js";
import { MessageTextDecoder } from "./decoder.js";
import { ImessageMcpError } from "./errors.js";
import { effectivePrivacy } from "./privacy.js";
import { errorResult, successResult } from "./result.js";
import { analyze, type AnalyticsScope, type Metric } from "./repositories/analytics.js";
import {
  ConversationCatalog,
  canonicalChatMap,
  type ConversationLabel,
  labelConversations,
  listConversations,
  conversationChatIds,
  type ConversationFilters,
} from "./repositories/conversations.js";
import { getConversationEvents, type TimelineEventType } from "./repositories/messages.js";
import { serviceFamilyCase } from "./schema-sql.js";
import { MemorySearchIndex } from "./search-index.js";
import { checkForUpdate } from "./update-check.js";
import { readAttachmentContent } from "./attachments.js";
import { decodeCursor, encodeCursor, MAX_SYNC_CURSOR_LENGTH, positiveId } from "./references.js";
import { assertCursorLog, materializeChanges } from "./changes.js";
import { cacheDirectory } from "./cache.js";
import { compileDateBounds } from "./time.js";

const dirnameHere = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(dirnameHere, "../package.json"), "utf8")) as { version: string };

type ToolParams = Record<string, unknown>;

function optionalString(params: ToolParams, key: string): string | undefined {
  return typeof params[key] === "string" ? params[key] : undefined;
}

function requestedPrivacy(config: RuntimeConfig, params: ToolParams): PrivacyMode {
  return effectivePrivacy(config.privacy_ceiling, optionalString(params, "privacy_mode") as PrivacyMode | undefined);
}

function dateInput(params: ToolParams): { date_from?: string; date_to?: string; timezone?: string } {
  return {
    date_from: optionalString(params, "date_from"),
    date_to: optionalString(params, "date_to"),
    timezone: optionalString(params, "timezone"),
  };
}

const LATEST_TEXT_CHARS = 280;

function clipText(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const PAGED_TOOLS = new Set(["list_conversations", "get_conversation", "search_messages", "sync_messages"]);
// Claude Code moves a result over about 50 KB to a file, so stay well under it.
const RESULT_BUDGET_BYTES = 40_000;

function resultBytes(result: CallToolResult): number {
  return result.content.reduce((total, block) => total + (block.type === "text" ? Buffer.byteLength(block.text, "utf8") : 0), 0);
}

// Adds a warning to an already-built result, keeping the JSON text block, which
// clients that read only content rely on, identical to structuredContent.
function withWarning(result: CallToolResult, warning: { code: string; message: string }): CallToolResult {
  const structured = result.structuredContent as { warnings?: unknown[] } | undefined;
  if (!structured) return result;
  const updated = { ...structured, warnings: [...(structured.warnings ?? []), warning] };
  const [first, ...rest] = result.content;
  const json = first?.type === "text" ? [{ type: "text" as const, text: JSON.stringify(updated) }] : first ? [first] : [];
  return { ...result, structuredContent: updated, content: [...json, ...rest] };
}

export class LocalToolRuntime {
  // Masks redacted handles consistently within this process and nowhere else.
  readonly maskingKey = randomBytes(32);
  readonly database: DatabaseContext;
  readonly contacts: UnifiedContactResolver;
  readonly decoder: MessageTextDecoder;
  readonly search: MemorySearchIndex;
  readonly conversationCatalog: ConversationCatalog;
  private detectedServicesCache: { watermark: string; values: ServiceFamily[] } | null = null;

  constructor(
    readonly config: RuntimeConfig,
    onSearchBuild?: () => void,
  ) {
    this.database = new DatabaseContext(config.database_path, config.source_mode);
    this.contacts = new UnifiedContactResolver(config.contacts_mode === "live");
    this.decoder = new MessageTextDecoder();
    this.conversationCatalog = new ConversationCatalog(this.database);
    // The live archive gets an encrypted on-disk checkpoint; copies stay in memory.
    const cache = config.source_mode === "live" && process.env.IMESSAGE_CACHE !== "0" ? cacheDirectory() : undefined;
    this.search = new MemorySearchIndex(this.database, this.decoder, this.contacts, onSearchBuild, cache);
  }

  // Builds the in-memory search index ahead of the first search. Searches default
  // to a complete index, so warm that first; a complete build rejects early (from
  // its size estimate) when the archive has bodies it cannot index, and then the
  // partial index a caller would retry with is the useful one to have ready.
  async warmSearch(): Promise<void> {
    try {
      await this.search.ensure(false);
    } catch {
      await this.search.ensure(true);
    }
  }

  close(): void {
    this.search.close();
    this.database.close();
  }

  async prepare(): Promise<void> {
    const request = this.database.request();
    try {
      this.detectedServices(request);
    } finally {
      request.close();
    }
  }

  private detectedServices(request: DatabaseRequest): ServiceFamily[] {
    const currentWatermark = watermarkToken(request.asOf);
    if (this.detectedServicesCache?.watermark === currentWatermark) {
      return [...this.detectedServicesCache.values];
    }
    const messageColumns = request.capabilities.tables.message ?? [];
    const chatColumns = request.capabilities.tables.chat ?? [];
    const sources: string[] = [];
    if (messageColumns.includes("service")) {
      sources.push(`SELECT ${serviceFamilyCase("service")} AS family FROM message WHERE service IS NOT NULL`);
    }
    if (chatColumns.includes("service_name")) {
      sources.push(`SELECT ${serviceFamilyCase("service_name")} AS family FROM chat WHERE service_name IS NOT NULL`);
    }
    const values = sources.length
      ? (request.db.prepare(
          `SELECT family FROM (${sources.join(" UNION ALL ")}) GROUP BY family ORDER BY family LIMIT 4`,
        ).all() as Array<{ family: ServiceFamily }>).map((row) => row.family)
      : [];
    this.detectedServicesCache = { watermark: currentWatermark, values };
    return [...values];
  }

  // A paged result larger than the budget is fetched again with a smaller
  // limit, so it fits in any client's tool-result window and the cursor still
  // continues where it stopped. Claude Code, for one, moves a larger result to
  // a file the model then has to dig through.
  async call(tool: string, params: ToolParams): Promise<CallToolResult> {
    let result = await this.dispatch(tool, params);
    if (!PAGED_TOOLS.has(tool) || result.isError) return result;
    const requested = Number(params.limit ?? 50);
    let limit = requested;
    for (let attempt = 0; attempt < 4 && limit > 1; attempt += 1) {
      const size = resultBytes(result);
      if (size <= RESULT_BUDGET_BYTES) break;
      limit = Math.max(1, Math.min(limit - 1, Math.floor((limit * RESULT_BUDGET_BYTES * 0.9) / size)));
      const smaller = await this.dispatch(tool, { ...params, limit });
      if (smaller.isError) break;
      result = smaller;
    }
    return limit < requested ? withWarning(result, {
      code: "RESULT_TRIMMED",
      message: `returned ${limit} of the requested ${requested} to stay under ${RESULT_BUDGET_BYTES} bytes; pass the cursor for more`,
    }) : result;
  }

  private async dispatch(tool: string, params: ToolParams): Promise<CallToolResult> {
    let privacy = this.config.privacy_ceiling;
    try {
      privacy = requestedPrivacy(this.config, params);
      if (tool === "server_status") return await this.serverStatus(privacy);
      if (tool === "resolve_contact") return this.resolveContact(params, privacy);
      if (tool === "list_conversations") return await this.listConversations(params, privacy);
      if (tool === "get_conversation") return await this.getConversation(params, privacy);
      if (tool === "search_messages") return await this.searchMessages(params, privacy);
      if (tool === "analyze_communication") return this.analyzeCommunication(params, privacy);
      if (tool === "sync_messages") return await this.syncMessages(params, privacy);
      if (tool === "get_attachment") return await this.getAttachment(params, privacy);
      throw new ImessageMcpError("INVALID_INPUT", "unknown tool");
    } catch (error) {
      return errorResult(tool, error, privacy, this.maskingKey);
    }
  }

  private databaseHandleResolution(query: string): ContactResolution {
    const request = this.database.request();
    try {
      const normalized = normalizeHandle(query);
      const count = Number((request.db.prepare("SELECT COUNT(*) AS count FROM handle").get() as { count: number }).count);
      if (count > 50_000) {
        throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "database contains too many handles for bounded resolution", {
          match_count: count,
          retry: "use live unified Contacts or query through conversation references",
        });
      }
      request.db.function("mcp_normalize_handle", { deterministic: true }, normalizeHandle);
      const rows = request.db
        .prepare("SELECT DISTINCT id FROM handle WHERE mcp_normalize_handle(id) = @normalized LIMIT 21")
        .all({ normalized }) as Array<{ id: string }>;
      if (rows.length > 20) {
        throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "exact handle matched too many database rows", {
          match_count: rows.length,
          retry: "provide the complete phone number or email address",
        });
      }
      const handles = [...new Set(rows.map((row) => row.id))].sort();
      return handles.length
        ? { status: "unique", contact: { name: null, handles, match: "exact_handle" } }
        : { status: "not_found" };
    } finally {
      request.close();
    }
  }

  private resolveContactQuery(query: string): ContactResolution {
    const cleaned = query.trim();
    if (!cleaned) throw new ImessageMcpError("INVALID_INPUT", "contact query must not be empty");
    const resolution = this.contacts.resolve(cleaned);
    const handleLike = looksLikeHandle(cleaned);
    if ((resolution.status === "unavailable" || resolution.status === "not_found") && handleLike) {
      return this.databaseHandleResolution(cleaned);
    }
    return resolution;
  }

  private resolveContactHandles(query: string): { handles: string[]; resolution: Record<string, unknown> } {
    const resolution = this.resolveContactQuery(query);
    if (resolution.status === "unique") return { handles: resolution.contact.handles, resolution };
    if (resolution.status === "ambiguous") {
      throw new ImessageMcpError("AMBIGUOUS_CONTACT", "contact matched more than one person; call resolve_contact with the same query to see them, then pass one of their handles as contact", {
        candidates: resolution.candidates,
      });
    }
    if (resolution.status === "unavailable") {
      throw new ImessageMcpError(
        "UNSUPPORTED_SCHEMA",
        "unified Contacts are unavailable for name resolution; use an exact phone number or email address",
        { capability: "contacts", state: "unavailable", retry: "use an exact phone number or email address" },
      );
    }
    return { handles: [], resolution };
  }

  private conversationFilters(params: ToolParams): ConversationFilters {
    const contact = optionalString(params, "contact");
    const resolved = contact ? this.resolveContactHandles(contact) : undefined;
    if (contact && resolved?.handles.length === 0) {
      return {
        handles: ["__no_such_handle__"],
        service: params.service_family as ServiceFamily | undefined,
        kind: params.kind as "direct" | "group" | undefined,
        replied: params.replied as boolean | undefined,
        bounds: compileDateBounds(dateInput(params)),
        order: params.order as "recent" | "most_messages" | undefined,
      };
    }
    return {
      ...(resolved ? { handles: resolved.handles } : {}),
      service: params.service_family as ServiceFamily | undefined,
      kind: params.kind as "direct" | "group" | undefined,
      replied: params.replied as boolean | undefined,
      order: params.order as "recent" | "most_messages" | undefined,
      bounds: compileDateBounds(dateInput(params)),
    };
  }

  private resolveConversation(params: { chat_id?: unknown; query?: unknown }): number[] {
    const queryValue = typeof params.query === "string" ? params.query : undefined;
    if (params.chat_id !== undefined && queryValue) {
      throw new ImessageMcpError("INVALID_INPUT", "provide chat_id or query, not both");
    }
    if (params.chat_id !== undefined) {
      const request = this.database.request();
      try {
        return conversationChatIds(request, params.chat_id);
      } finally {
        request.close();
      }
    }
    const query = queryValue?.trim();
    if (!query) throw new ImessageMcpError("INVALID_INPUT", "chat_id or a nonempty query is required");
    const contactResolution = this.resolveContactQuery(query);
    if (contactResolution.status === "ambiguous") {
      throw new ImessageMcpError("AMBIGUOUS_CONTACT", "query matched more than one person; call resolve_contact with the same query to see them, then pass one of their handles as query, or a chat_id from list_conversations", {
        candidates: contactResolution.candidates,
      });
    }
    if (contactResolution.status === "unique") {
      // "My texts with Kapil" means the one-to-one chat; group chats he is in
      // are only a fallback when there is no single DM.
      const find = (kind?: "direct") => listConversations({
        context: this.database,
        contacts: this.contacts,
        filters: { handles: contactResolution.contact.handles, kind, bounds: compileDateBounds({}) },
        limit: 2,
        privacy: "full",
        catalog: this.conversationCatalog,
      }).conversations;
      const direct = find("direct");
      const found = direct.length === 1 ? direct : find();
      if (found.length === 1) {
        const request = this.database.request();
        try {
          return conversationChatIds(request, found[0].chat_id);
        } finally {
          request.close();
        }
      }
      if (found.length > 1) {
        throw new ImessageMcpError("AMBIGUOUS_CONTACT", "this person has no single one-to-one chat and is in several group chats; call list_conversations with the same contact, then pass the chosen chat_id", {
          match_count: found.length,
        });
      }
    }
    const request = this.database.request();
    try {
      if (!(request.capabilities.tables.chat ?? []).includes("display_name")) {
        throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "conversation-name lookup is unavailable in this Messages schema");
      }
      const exact = request.db
        .prepare("SELECT ROWID AS id FROM chat WHERE display_name = ? COLLATE NOCASE LIMIT 21")
        .all(query) as Array<{ id: number }>;
      const rows = exact.length
        ? exact
        : request.db
            .prepare("SELECT ROWID AS id FROM chat WHERE display_name LIKE ? ESCAPE '\\' LIMIT 21")
            .all(`%${query.replace(/[\\%_]/gu, "\\$&")}%`) as Array<{ id: number }>;
      if (rows.length === 0) throw new ImessageMcpError("INVALID_INPUT", "conversation query did not resolve");
      if (rows.length > 20) {
        throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "conversation query matched too many chats", {
          match_count: rows.length,
          retry: "provide a more specific name or a chat_id",
        });
      }
      const canonical = canonicalChatMap(request);
      if (rows.length > 1) {
        const roots = new Set(rows.map((row) => canonical.get(row.id) ?? row.id));
        if (roots.size > 1) {
          throw new ImessageMcpError("AMBIGUOUS_CONTACT", "query matched more than one conversation; call list_conversations and pass the chosen chat_id", {
            match_count: roots.size,
          });
        }
      }
      const root = canonical.get(rows[0].id) ?? rows[0].id;
      const component = [...canonical.entries()]
        .filter(([, canonicalId]) => canonicalId === root)
        .map(([chatId]) => chatId)
        .sort((a, b) => a - b);
      return component.length ? component : [rows[0].id];
    } finally {
      request.close();
    }
  }

  private async serverStatus(privacy: PrivacyMode): Promise<CallToolResult> {
    const update = await checkForUpdate(packageJson.version);
    const request = this.database.request();
    try {
      const detectedServices = this.detectedServices(request);
      return successResult({
        tool: "server_status",
        privacy,
        maskingKey: this.maskingKey,
        effectiveScope: { privacy_mode: privacy },
        data: {
          api_version: API_VERSION,
          package_version: packageJson.version,
          privacy_ceiling: this.config.privacy_ceiling,
          source_mode: this.config.source_mode,
          detected_services: detectedServices,
          schema_capabilities: this.database.capabilities,
          contacts: this.contacts.status(),
          index_state: this.search.state(),
          as_of: watermarkToken(request.asOf),
          update,
        },
      });
    } finally {
      request.close();
    }
  }

  private resolveContact(params: ToolParams, privacy: PrivacyMode): CallToolResult {
    const cleaned = optionalString(params, "query")?.trim() ?? "";
    if (!cleaned) throw new ImessageMcpError("INVALID_INPUT", "contact query must not be empty");
    const resolution = this.resolveContactQuery(cleaned);
    return successResult({
      tool: "resolve_contact",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: { privacy_mode: privacy },
      data: resolution.status === "unique"
        ? { status: "unique", contact: resolution.contact }
        : resolution.status === "ambiguous"
          ? { status: "ambiguous", candidates: resolution.candidates }
          : resolution,
    });
  }

  private async listConversations(params: ToolParams, privacy: PrivacyMode): Promise<CallToolResult> {
    const filters = this.conversationFilters(params);
    const listed = listConversations({
      context: this.database,
      contacts: this.contacts,
      filters,
      limit: Number(params.limit ?? 50),
      cursor: optionalString(params, "cursor"),
      privacy,
      catalog: this.conversationCatalog,
    });
    // Each conversation carries its latest message, so "who is waiting on me"
    // takes one call instead of one get_conversation per thread.
    const conversations = [];
    for (const [index, conversation] of listed.conversations.entries()) {
      const latest = await getConversationEvents({
        context: this.database,
        contacts: this.contacts,
        decoder: this.decoder,
        chatIds: listed.chatIds[index],
        limit: 1,
        bounds: compileDateBounds({ timezone: filters.bounds.timezone }),
        eventFilters: ["message"],
        allowPartial: true,
        privacy,
        includeAttachmentPaths: false,
      }).then((result) => result.events.at(-1), () => undefined);
      conversations.push(latest ? {
        ...conversation,
        latest_message: {
          message_id: latest.message_id,
          timestamp: latest.timestamp,
          direction: latest.direction,
          sender: latest.sender,
          ...(latest.text !== undefined ? { text: clipText(latest.text, LATEST_TEXT_CHARS) } : {}),
          ...(latest.attachments?.length ? { attachment_count: latest.attachments.length } : {}),
        },
      } : conversation);
    }
    return successResult({
      tool: "list_conversations",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: {
        privacy_mode: privacy,
        timezone: filters.bounds.timezone,
        service_family: params.service_family ?? "all",
      },
      data: { conversations },
      page: { next_cursor: listed.nextCursor, has_more: listed.hasMore, as_of: listed.asOf },
    });
  }

  private async getConversation(params: ToolParams, privacy: PrivacyMode): Promise<CallToolResult> {
    const chatIds = this.resolveConversation(params);
    const bounds = compileDateBounds(dateInput(params));
    const result = await getConversationEvents({
      context: this.database,
      contacts: this.contacts,
      decoder: this.decoder,
      chatIds,
      limit: Number(params.limit ?? 50),
      bounds,
      service: params.service_family as ServiceFamily | undefined,
      eventFilters: params.event_types as TimelineEventType[] | undefined,
      aroundMessage: typeof params.around_message_id === "number" ? params.around_message_id : undefined,
      cursor: optionalString(params, "cursor"),
      allowPartial: Boolean(params.allow_partial),
      privacy,
      includeAttachmentPaths: false,
    });
    return successResult({
      tool: "get_conversation",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: {
        privacy_mode: privacy,
        timezone: bounds.timezone,
        service_family: params.service_family ?? "all",
      },
      data: { conversation: this.labelFor(chatIds), events: result.events },
      page: { next_cursor: result.nextCursor, has_more: result.hasMore, as_of: result.asOf },
      warnings: result.warnings,
    });
  }

  // Every result names its conversation the way the user would, so an
  // assistant never has to describe a chat by its number.
  private withConversationLabels<T extends { chat_id?: number }>(hits: T[]): Array<T & { conversation?: ConversationLabel }> {
    const labels = labelConversations({
      context: this.database,
      contacts: this.contacts,
      catalog: this.conversationCatalog,
      chatIds: hits.map((hit) => hit.chat_id).filter((id): id is number => typeof id === "number"),
    });
    return hits.map((hit) => {
      const label = typeof hit.chat_id === "number" ? labels.get(hit.chat_id) : undefined;
      return label ? { ...hit, conversation: label } : hit;
    });
  }

  private labelFor(chatIds: number[]): ConversationLabel | undefined {
    const labels = labelConversations({ context: this.database, contacts: this.contacts, catalog: this.conversationCatalog, chatIds });
    return chatIds.map((id) => labels.get(id)).find(Boolean);
  }

  private async searchMessages(params: ToolParams, privacy: PrivacyMode): Promise<CallToolResult> {
    const query = optionalString(params, "query") ?? "";
    if (!query.length) throw new ImessageMcpError("INVALID_INPUT", "search query must not be empty");
    const bounds = compileDateBounds(dateInput(params));
    const result = await this.search.search({
      query,
      mode: params.mode as "substring" | "exact" | "token" | "phrase",
      scopes: params.scopes as Array<"text" | "conversation_names" | "attachment_filenames">,
      order: params.order as "newest" | "relevance",
      bounds,
      service: params.service_family as ServiceFamily | undefined,
      fromMe: typeof params.from_me === "boolean" ? params.from_me : undefined,
      limit: Number(params.limit ?? 50),
      cursor: optionalString(params, "cursor"),
      allowPartial: Boolean(params.allow_partial),
      privacy,
    });
    return successResult({
      tool: "search_messages",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: {
        privacy_mode: privacy,
        timezone: bounds.timezone,
        scopes: params.scopes,
        service_family: params.service_family ?? "all",
        from_me: typeof params.from_me === "boolean" ? params.from_me : "all",
      },
      data: { total_matches: result.total, results: this.withConversationLabels(result.hits) },
      page: { next_cursor: result.nextCursor, has_more: result.hasMore, as_of: result.asOf },
      warnings: result.warnings,
    });
  }

  private analyzeCommunication(params: ToolParams, privacy: PrivacyMode): CallToolResult {
    const scopeName = params.scope as "global" | "contact" | "conversation";
    const scope: AnalyticsScope = scopeName === "global"
      ? { kind: "global" }
      : scopeName === "contact"
        ? { kind: "contact", handles: this.resolveContactHandles(optionalString(params, "contact") ?? "").handles }
        : { kind: "conversation", chatIds: this.resolveConversation({ chat_id: params.chat_id }) };
    const bounds = compileDateBounds(dateInput(params));
    const result = analyze({
      context: this.database,
      scope,
      metric: params.metric as Metric,
      bounds,
      sessionGapHours: Number(params.session_gap_hours ?? 8),
    });
    return successResult({
      tool: "analyze_communication",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: { privacy_mode: privacy, scope: scopeName, timezone: bounds.timezone },
      data: result,
    });
  }

  private async syncMessages(params: ToolParams, privacy: PrivacyMode): Promise<CallToolResult> {
    await this.search.ensure(true);
    const log = this.search.changeLog();
    const cursorFor = (seq: number) => encodeCursor("sync", { v: 3, seq, log: log.logId, db: log.databaseId });
    const cursor = optionalString(params, "cursor");
    if (cursor === undefined) {
      return successResult({
        tool: "sync_messages",
        privacy,
        maskingKey: this.maskingKey,
        effectiveScope: { privacy_mode: privacy },
        data: { changes: [], cursor: cursorFor(log.latestSeq) },
        page: { next_cursor: null, has_more: false, as_of: log.logId },
      });
    }
    const afterSeq = assertCursorLog(decodeCursor("sync", cursor, MAX_SYNC_CURSOR_LENGTH), log.logId, log.databaseId, log.oldestSeq);
    const limit = Number(params.limit ?? 50);
    const rows = log.read(afterSeq, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const request = this.database.request();
    let changes: Awaited<ReturnType<typeof materializeChanges>>;
    try {
      changes = await materializeChanges({ request, contacts: this.contacts, decoder: this.decoder, rows: page });
    } finally {
      request.close();
    }
    const partial = changes.filter((change) => change.row_status === "partial").length;
    const next = cursorFor(page.at(-1)?.seq ?? afterSeq);
    return successResult({
      tool: "sync_messages",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: { privacy_mode: privacy },
      data: { changes, cursor: next },
      page: { next_cursor: hasMore ? next : null, has_more: hasMore, as_of: log.logId },
      warnings: partial > 0
        ? [{ code: "PARTIAL_ROWS", message: "some changed rows could not be fully read (undecodable body, unknown sender, or a message deleted since)", skipped_count: partial }]
        : [],
    });
  }

  private async getAttachment(params: ToolParams, privacy: PrivacyMode): Promise<CallToolResult> {
    if (privacy !== "full") {
      throw new ImessageMcpError("PRIVACY_RESTRICTED", "attachment content requires the full privacy mode");
    }
    const attachmentId = positiveId(params.attachment_id, "attachment_id");
    const request = this.database.request();
    let record: { filename: string | null; transfer_name: string | null; mime_type: string | null; uti: string | null; total_bytes: number | null } | undefined;
    try {
      if (request.capabilities.attachments !== "available") {
        throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "this Messages database has no attachment tables");
      }
      const columns = request.capabilities.tables.attachment ?? [];
      const column = (name: string) => (columns.includes(name) ? name : `NULL AS ${name}`);
      record = request.db.prepare(
        `SELECT ${column("filename")}, ${column("transfer_name")}, ${column("mime_type")}, ${column("uti")}, ${column("total_bytes")}
         FROM attachment WHERE ROWID = ?`,
      ).get(attachmentId) as typeof record;
    } finally {
      request.close();
    }
    if (!record) throw new ImessageMcpError("INVALID_INPUT", "attachment_id was not found");
    const content = await readAttachmentContent(record, {
      maxLongEdge: typeof params.max_long_edge === "number" ? params.max_long_edge : undefined,
    });
    const name = record.transfer_name ?? (record.filename ? record.filename.split("/").pop() ?? null : null);
    const result = successResult({
      tool: "get_attachment",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: { privacy_mode: privacy },
      data: {
        attachment_id: attachmentId,
        filename: name,
        mime_type: record.mime_type,
        bytes: record.total_bytes,
        content: content.kind,
        ...(content.kind === "metadata" ? { reason: content.reason } : {}),
        ...(content.kind === "image" ? { width: content.width, height: content.height } : {}),
        ...(content.kind === "text" ? { truncated: content.truncated } : {}),
      },
    });
    if (content.kind === "image") {
      result.content = [...result.content, { type: "image", data: content.data.toString("base64"), mimeType: content.mimeType }];
    } else if (content.kind === "text") {
      result.content = [...result.content, { type: "text", text: content.text }];
    }
    return result;
  }
}
