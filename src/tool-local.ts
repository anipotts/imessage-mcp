import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RuntimeConfig } from "./config.js";
import type { PrivacyMode, ServiceFamily } from "./contracts.js";
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
  listConversations,
  resolveConversationReference,
  type ConversationFilters,
} from "./repositories/conversations.js";
import { getConversationEvents, type TimelineEventType } from "./repositories/messages.js";
import { prepareCopiedDatabaseSync, syncMessages } from "./repositories/sync.js";
import { serviceFamilyCase } from "./schema-sql.js";
import { MemorySearchIndex } from "./search-index.js";
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

export class LocalToolRuntime {
  readonly database: DatabaseContext;
  readonly contacts: UnifiedContactResolver;
  readonly decoder: MessageTextDecoder;
  readonly search: MemorySearchIndex;
  readonly conversationCatalog: ConversationCatalog;
  private detectedServicesCache: { watermark: string; values: ServiceFamily[] } | null = null;

  constructor(
    readonly config: RuntimeConfig,
    readonly maskingKey: Buffer,
    decoderLock?: SharedArrayBuffer,
    decoderOwner = 1,
    warmConversationCatalog = false,
  ) {
    if (!config.reference_key) {
      throw new ImessageMcpError(
        "INVALID_INPUT",
        "configure IMESSAGE_REFERENCE_KEY or an operator-owned IMESSAGE_REFERENCE_KEY_FILE before starting the server",
      );
    }
    this.database = new DatabaseContext(
      config.database_path,
      Buffer.from(config.reference_key, "base64"),
      config.source_mode,
    );
    this.contacts = new UnifiedContactResolver(config.contacts_mode === "live");
    this.decoder = new MessageTextDecoder(decoderLock, decoderOwner);
    this.conversationCatalog = new ConversationCatalog(this.database);
    if (warmConversationCatalog) this.conversationCatalog.warm();
    this.search = new MemorySearchIndex(this.database, this.decoder, this.contacts);
  }

  close(): void {
    this.search.close();
    this.database.close();
  }

  async prepare(): Promise<void> {
    await prepareCopiedDatabaseSync(this.database);
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

  async call(tool: string, params: ToolParams): Promise<CallToolResult> {
    let privacy = this.config.privacy_ceiling;
    try {
      privacy = requestedPrivacy(this.config, params);
      if (tool === "server_status") return this.serverStatus(privacy);
      if (tool === "resolve_contact") return this.resolveContact(params, privacy);
      if (tool === "list_conversations") return this.listConversations(params, privacy);
      if (tool === "get_conversation") return await this.getConversation(params, privacy);
      if (tool === "search_messages") return await this.searchMessages(params, privacy);
      if (tool === "analyze_communication") return this.analyzeCommunication(params, privacy);
      if (tool === "sync_messages") return await this.syncMessages(params, privacy);
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
      throw new ImessageMcpError("AMBIGUOUS_CONTACT", "contact query matched multiple unified contacts", {
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
      };
    }
    return {
      ...(resolved ? { handles: resolved.handles } : {}),
      service: params.service_family as ServiceFamily | undefined,
      kind: params.kind as "direct" | "group" | undefined,
      replied: params.replied as boolean | undefined,
      bounds: compileDateBounds(dateInput(params)),
    };
  }

  private resolveConversation(params: { conversation_ref?: unknown; query?: unknown }): number[] {
    const conversationRef = typeof params.conversation_ref === "string" ? params.conversation_ref : undefined;
    const queryValue = typeof params.query === "string" ? params.query : undefined;
    if (conversationRef && queryValue) {
      throw new ImessageMcpError("INVALID_INPUT", "provide conversation_ref or query, not both");
    }
    if (conversationRef) {
      return resolveConversationReference(this.database.referenceKey, this.database.lineage, conversationRef);
    }
    const query = queryValue?.trim();
    if (!query) throw new ImessageMcpError("INVALID_INPUT", "conversation_ref or a nonempty query is required");
    const contactResolution = this.resolveContactQuery(query);
    if (contactResolution.status === "ambiguous") {
      throw new ImessageMcpError("AMBIGUOUS_CONTACT", "contact query matched multiple unified contacts", {
        candidates: contactResolution.candidates,
      });
    }
    if (contactResolution.status === "unique") {
      const found = listConversations({
        context: this.database,
        contacts: this.contacts,
        filters: { handles: contactResolution.contact.handles, bounds: compileDateBounds({}) },
        limit: 2,
        privacy: "full",
        catalog: this.conversationCatalog,
      });
      if (found.conversations.length === 1) {
        return resolveConversationReference(
          this.database.referenceKey,
          this.database.lineage,
          found.conversations[0].conversation_ref,
        );
      }
      if (found.conversations.length > 1) {
        throw new ImessageMcpError("AMBIGUOUS_CONTACT", "contact participates in multiple conversations", {
          match_count: found.conversations.length,
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
          retry: "provide a more specific name or a conversation reference",
        });
      }
      const canonical = canonicalChatMap(request);
      if (rows.length > 1) {
        const roots = new Set(rows.map((row) => canonical.get(row.id) ?? row.id));
        if (roots.size > 1) {
          throw new ImessageMcpError("AMBIGUOUS_CONTACT", "conversation query matched multiple conversations", {
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

  private serverStatus(privacy: PrivacyMode): CallToolResult {
    const request = this.database.request();
    try {
      const detectedServices = this.detectedServices(request);
      return successResult({
        tool: "server_status",
        privacy,
        maskingKey: this.maskingKey,
        effectiveScope: { privacy_mode: privacy },
        data: {
          api_version: "2.0",
          package_version: packageJson.version,
          privacy_ceiling: this.config.privacy_ceiling,
          source_mode: this.config.source_mode,
          detected_services: detectedServices,
          schema_capabilities: this.database.capabilities,
          decoder_health: this.decoder.healthState(),
          index_state: this.search.state(),
          as_of: watermarkToken(request.asOf),
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

  private listConversations(params: ToolParams, privacy: PrivacyMode): CallToolResult {
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
    return successResult({
      tool: "list_conversations",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: {
        privacy_mode: privacy,
        timezone: filters.bounds.timezone,
        service_family: params.service_family ?? "all",
      },
      data: { conversations: listed.conversations },
      page: { next_cursor: listed.nextCursor, has_more: listed.hasMore, as_of: listed.asOf },
    });
  }

  private async getConversation(params: ToolParams, privacy: PrivacyMode): Promise<CallToolResult> {
    if (params.include_attachment_paths && (privacy !== "full" || !this.config.attachment_paths_enabled)) {
      throw new ImessageMcpError(
        "PRIVACY_RESTRICTED",
        "attachment paths require full mode and the startup attachment-path flag",
      );
    }
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
      aroundMessage: optionalString(params, "around_message"),
      cursor: optionalString(params, "cursor"),
      allowPartial: Boolean(params.allow_partial),
      privacy,
      includeAttachmentPaths: Boolean(params.include_attachment_paths),
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
      data: { events: result.events },
      page: { next_cursor: result.nextCursor, has_more: result.hasMore, as_of: result.asOf },
      warnings: result.warnings,
    });
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
      },
      data: { total_matches: result.total, results: result.hits },
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
        : { kind: "conversation", chatIds: this.resolveConversation({ conversation_ref: params.conversation_ref }) };
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
    const result = await syncMessages({
      context: this.database,
      contacts: this.contacts,
      decoder: this.decoder,
      cursor: optionalString(params, "cursor"),
      limit: Number(params.limit ?? 50),
      allowPartial: Boolean(params.allow_partial),
      privacy,
      catalog: this.conversationCatalog,
    });
    return successResult({
      tool: "sync_messages",
      privacy,
      maskingKey: this.maskingKey,
      effectiveScope: { privacy_mode: privacy },
      data: { changes: result.changes, cursor: result.cursor },
      page: { next_cursor: result.hasMore ? result.cursor : null, has_more: result.hasMore, as_of: result.asOf },
      warnings: result.warnings,
    });
  }
}
