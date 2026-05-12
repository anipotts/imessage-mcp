// Authentication + OAuth 2.1 authorization server semantics.
//
// Supports:
// - Legacy static bearer tokens
// - OAuth 2.1 endpoints (metadata, authorize+PKCE, token, DCR, JWKS, introspection, revocation)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";
import type { AuthPrincipal } from "./context.js";
import { getDefaultProfileId, getProfileIds, resolveAllowedProfileId } from "./profiles.js";

export type AuthMode = "bearer" | "oauth2";

export interface AuthSuccess {
  ok: true;
  principal: AuthPrincipal;
}

export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
  wwwAuthenticate?: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

interface StaticBearerCredential {
  token: string;
  subject: string;
  client_id: string;
  scopes: string[];
  profiles: string[];
  is_admin: boolean;
}

interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  grant_types: string[];
  response_types: string[];
  scope: string;
  allowed_scopes: string[];
  allowed_profiles: string[];
  created_at: string;
}

interface OAuthAuthCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  subject: string;
  profile_id: string;
  profiles: string[];
  code_challenge: string;
  code_challenge_method: "S256";
  expires_at: number;
  used: boolean;
  created_at: string;
}

interface OAuthRefreshToken {
  token_hash: string;
  client_id: string;
  subject: string;
  scope: string;
  profile_id: string;
  profiles: string[];
  expires_at: number;
  revoked: boolean;
  created_at: string;
}

interface OAuthAccessTokenMeta {
  jti: string;
  client_id: string;
  subject: string;
  scope: string;
  profile_id: string;
  profiles: string[];
  exp: number;
  revoked: boolean;
  created_at: string;
}

interface OAuthRegistrationAccessTokenMeta {
  token_hash: string;
  client_id: string;
  created_at: string;
  revoked: boolean;
}

interface OAuthState {
  version: 1;
  kid: string | null;
  private_jwk: JWK | null;
  public_jwk: JWK | null;
  clients: Record<string, OAuthClient>;
  auth_codes: Record<string, OAuthAuthCode>;
  refresh_tokens: Record<string, OAuthRefreshToken>;
  access_tokens: Record<string, OAuthAccessTokenMeta>;
  registration_access_tokens: Record<string, OAuthRegistrationAccessTokenMeta>;
  revoked_jtis: Record<string, number>;
}

interface HttpLikeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  destroy: () => void;
}

interface HttpLikeResponse {
  headersSent?: boolean;
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  end: (body?: string) => void;
}

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_AUTH_STORE = join(homedir(), ".imessage-mcp", "oauth-store.json");

const DEFAULT_SCOPE_SET = [
  "messages.read",
  "analytics.read",
  "sync.read",
  "export.read",
  "index.read",
  "webhooks.manage",
  "index.manage",
  "oauth.admin",
];
const DEFAULT_BEARER_SCOPE_SET = [...DEFAULT_SCOPE_SET, "admin.*"];

const ACCESS_TOKEN_TTL_SECONDS = parseInt(process.env.IMESSAGE_OAUTH_ACCESS_TOKEN_TTL ?? "3600", 10) || 3600;
const REFRESH_TOKEN_TTL_SECONDS = parseInt(process.env.IMESSAGE_OAUTH_REFRESH_TOKEN_TTL ?? String(60 * 60 * 24 * 30), 10) || (60 * 60 * 24 * 30);
const AUTH_CODE_TTL_SECONDS = parseInt(process.env.IMESSAGE_OAUTH_AUTH_CODE_TTL ?? "600", 10) || 600;
const OAUTH_AUTO_APPROVE = (process.env.IMESSAGE_OAUTH_AUTO_APPROVE ?? "true").toLowerCase() !== "false";
const OAUTH_ADMIN_SCOPES = parseCsv(process.env.IMESSAGE_OAUTH_ADMIN_SCOPES || "admin.*,oauth.admin");

let cachedState: OAuthState | null = null;
let stateInitPromise: Promise<void> | null = null;

function getAuthStorePath(): string {
  return process.env.IMESSAGE_AUTH_STORE || DEFAULT_AUTH_STORE;
}

function getAuthMode(): AuthMode {
  const mode = (process.env.IMESSAGE_AUTH_MODE || "bearer").toLowerCase();
  if (mode === "oauth2") return "oauth2";
  return "bearer";
}

function authRequiredByDefault(): boolean {
  return (process.env.IMESSAGE_REQUIRE_AUTH ?? "true").toLowerCase() !== "false";
}

function adminScopesRequired(): string[] {
  return OAUTH_ADMIN_SCOPES.length > 0 ? OAUTH_ADMIN_SCOPES : ["admin.*", "oauth.admin"];
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toScopeList(scope: string | undefined | null): string[] {
  if (!scope) return [];
  return scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scopeAllows(granted: string[], required: string): boolean {
  if (granted.includes("*") || granted.includes("admin.*")) return true;
  if (granted.includes(required)) return true;
  const [domain] = required.split(".");
  if (domain && granted.includes(`${domain}.*`)) return true;
  return false;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function ensureKnownScopes(scopes: string[]): string[] {
  const requested = dedupe(scopes.filter(Boolean));
  if (requested.length === 0) {
    const fromEnv = parseCsv(process.env.IMESSAGE_OAUTH_DEFAULT_SCOPES);
    return fromEnv.length > 0 ? dedupe(fromEnv) : [...DEFAULT_SCOPE_SET];
  }

  const known = new Set([...DEFAULT_SCOPE_SET, ...parseCsv(process.env.IMESSAGE_OAUTH_EXTRA_SCOPES)]);
  return requested.filter((scope) => known.has(scope) || scope.includes("*"));
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

function defaultOAuthState(): OAuthState {
  return {
    version: 1,
    kid: null,
    private_jwk: null,
    public_jwk: null,
    clients: {},
    auth_codes: {},
    refresh_tokens: {},
    access_tokens: {},
    registration_access_tokens: {},
    revoked_jtis: {},
  };
}

function loadState(): OAuthState {
  if (cachedState) return cachedState;

  const file = getAuthStorePath();
  if (!existsSync(file)) {
    cachedState = defaultOAuthState();
    return cachedState;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as OAuthState;
    if (!parsed || parsed.version !== 1) {
      cachedState = defaultOAuthState();
      return cachedState;
    }

    cachedState = {
      ...defaultOAuthState(),
      ...parsed,
      clients: parsed.clients || {},
      auth_codes: parsed.auth_codes || {},
      refresh_tokens: parsed.refresh_tokens || {},
      access_tokens: parsed.access_tokens || {},
      registration_access_tokens: parsed.registration_access_tokens || {},
      revoked_jtis: parsed.revoked_jtis || {},
    };
    return cachedState;
  } catch {
    cachedState = defaultOAuthState();
    return cachedState;
  }
}

function applySecureStorePermissions(file: string): void {
  const dir = dirname(file);
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    process.stderr.write(`[auth] Warning: could not enforce 0700 permissions on ${dir}: ${err}\n`);
  }
  try {
    if (existsSync(file)) {
      chmodSync(file, 0o600);
    }
  } catch (err) {
    process.stderr.write(`[auth] Warning: could not enforce 0600 permissions on ${file}: ${err}\n`);
  }
}

function saveState(state: OAuthState): void {
  const file = getAuthStorePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  applySecureStorePermissions(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Ignore if filesystem does not support chmod (best effort).
  }
  renameSync(tmp, file);
  applySecureStorePermissions(file);
}

function pruneState(state: OAuthState): void {
  const now = Math.floor(Date.now() / 1000);

  for (const [hash, code] of Object.entries(state.auth_codes)) {
    if (code.used || code.expires_at <= now) {
      delete state.auth_codes[hash];
    }
  }

  for (const [hash, token] of Object.entries(state.refresh_tokens)) {
    if (token.revoked || token.expires_at <= now) {
      delete state.refresh_tokens[hash];
    }
  }

  for (const [jti, token] of Object.entries(state.access_tokens)) {
    if (token.revoked || token.exp <= now) {
      delete state.access_tokens[jti];
    }
  }

  for (const [jti, exp] of Object.entries(state.revoked_jtis)) {
    if (exp <= now) {
      delete state.revoked_jtis[jti];
    }
  }

  for (const [hash, meta] of Object.entries(state.registration_access_tokens)) {
    if (meta.revoked) {
      delete state.registration_access_tokens[hash];
    }
  }
}

async function ensureSigningKey(state: OAuthState): Promise<void> {
  if (state.private_jwk && state.public_jwk && state.kid) return;

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = randomToken(12);

  publicJwk.kid = kid;
  privateJwk.kid = kid;

  state.public_jwk = publicJwk;
  state.private_jwk = privateJwk;
  state.kid = kid;
}

async function ensureStateReady(): Promise<OAuthState> {
  if (!stateInitPromise) {
    stateInitPromise = (async () => {
      const state = loadState();
      applySecureStorePermissions(getAuthStorePath());
      pruneState(state);
      await ensureSigningKey(state);
      saveState(state);
    })();
  }

  await stateInitPromise;
  return loadState();
}

function json(res: HttpLikeResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(body));
}

function html(res: HttpLikeResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function oauthError(
  res: HttpLikeResponse,
  status: number,
  error: string,
  description?: string,
  extra?: Record<string, unknown>,
): void {
  json(res, status, {
    error,
    ...(description ? { error_description: description } : {}),
    ...(extra || {}),
  });
}

function redirectWithParams(res: HttpLikeResponse, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

async function readBody(req: HttpLikeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request aborted")));
  });
}

function parseBasicAuth(header: string | undefined): { client_id: string; client_secret: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  const raw = header.slice("Basic ".length).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return null;
  }

  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  const client_id = decoded.slice(0, idx);
  const client_secret = decoded.slice(idx + 1);
  if (!client_id) return null;
  return { client_id, client_secret };
}

function parseBodyParams(contentType: string, body: string): Record<string, string> {
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
        if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      return out;
    } catch {
      return {};
    }
  }

  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

function normalizeAllowedProfiles(input: string[] | undefined): string[] {
  const known = getProfileIds();
  if (!input || input.length === 0) return known;
  if (input.includes("*")) return known;
  return input.filter((p) => known.includes(p));
}

function normalizeBearerCredentials(): StaticBearerCredential[] {
  const fromJson = process.env.IMESSAGE_BEARER_TOKENS;
  if (fromJson) {
    try {
      const parsed = JSON.parse(fromJson);
      if (Array.isArray(parsed)) {
        const creds: StaticBearerCredential[] = [];
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const token = String((item as any).token || "").trim();
          if (!token) continue;
          creds.push({
            token,
            subject: String((item as any).subject || "bearer-subject"),
            client_id: String((item as any).client_id || "bearer-client"),
            scopes: ensureKnownScopes(Array.isArray((item as any).scopes) ? (item as any).scopes : toScopeList((item as any).scope)),
            profiles: normalizeAllowedProfiles(Array.isArray((item as any).profiles) ? (item as any).profiles : parseCsv((item as any).profiles)),
            is_admin: Boolean((item as any).is_admin),
          });
        }
        if (creds.length > 0) return creds;
      }
    } catch (err) {
      process.stderr.write(`[auth] Invalid IMESSAGE_BEARER_TOKENS JSON: ${err}\n`);
    }
  }

  const fallbackToken = process.env.IMESSAGE_API_TOKEN || "";
  if (!fallbackToken) return [];

  return [
    {
      token: fallbackToken,
      subject: process.env.IMESSAGE_BEARER_SUBJECT || "legacy-bearer",
      client_id: process.env.IMESSAGE_BEARER_CLIENT_ID || "legacy-client",
      scopes: (() => {
        const configured = parseCsv(process.env.IMESSAGE_BEARER_SCOPES);
        if (configured.length > 0) return ensureKnownScopes(configured);
        return ensureKnownScopes(DEFAULT_BEARER_SCOPE_SET);
      })(),
      profiles: normalizeAllowedProfiles(parseCsv(process.env.IMESSAGE_BEARER_PROFILES)),
      is_admin: true,
    },
  ];
}

function bearerUnauthorized(): AuthFailure {
  return {
    ok: false,
    status: 401,
    error: "Unauthorized",
    wwwAuthenticate: "Bearer",
  };
}

function principalFromBearerCredential(cred: StaticBearerCredential): AuthPrincipal {
  return {
    auth_mode: "bearer",
    subject: cred.subject,
    client_id: cred.client_id,
    scopes: cred.scopes,
    allowed_profiles: cred.profiles,
    active_profile: getDefaultProfileId(),
    token_id: sha256(cred.token).slice(0, 16),
    is_admin: cred.is_admin,
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const direct = headers[name];
  if (Array.isArray(direct)) return direct[0];
  if (typeof direct === "string") return direct;

  const lower = headers[name.toLowerCase()];
  if (Array.isArray(lower)) return lower[0];
  if (typeof lower === "string") return lower;

  return undefined;
}

function extractBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headerValue(headers, "authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

function hasRequiredScopes(scopes: string[], required: string[]): boolean {
  if (required.length === 0) return true;
  const normalized = scopes.map((scope) => scope.toLowerCase());
  return required.some((scope) => scopeAllows(normalized, scope.toLowerCase()));
}

function findStaticBearerPrincipal(headers: Record<string, string | string[] | undefined>): AuthPrincipal | null {
  const token = extractBearerToken(headers);
  if (!token) return null;
  const creds = normalizeBearerCredentials();
  for (const cred of creds) {
    if (safeEqualString(token, cred.token)) {
      return principalFromBearerCredential(cred);
    }
  }
  return null;
}

export interface AuthenticateRequestOptions {
  requireAuth?: boolean;
}

function selectGrantedScopes(requested: string[] | null, allowed: string[]): string[] {
  const normalizedAllowed = ensureKnownScopes(allowed);
  if (!requested || requested.length === 0) {
    return normalizedAllowed;
  }

  const normalizedRequested = ensureKnownScopes(requested);
  return normalizedRequested.filter((scope) => normalizedAllowed.some((a) => scopeAllows([a], scope)));
}

async function importPrivateKey(state: OAuthState) {
  if (!state.private_jwk) throw new Error("Missing OAuth signing key");
  return importJWK(state.private_jwk, "ES256");
}

async function importPublicKey(state: OAuthState) {
  if (!state.public_jwk) throw new Error("Missing OAuth signing key");
  return importJWK(state.public_jwk, "ES256");
}

interface IssuedTokenSet {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
  refresh_token?: string;
  profile_id: string;
}

async function issueTokens(params: {
  state: OAuthState;
  issuer: string;
  client_id: string;
  subject: string;
  scopeList: string[];
  profile_id: string;
  profiles: string[];
  include_refresh_token: boolean;
}): Promise<IssuedTokenSet> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_SECONDS;
  const jti = randomToken(18);
  const scope = params.scopeList.join(" ");

  const privateKey = await importPrivateKey(params.state);
  const token = await new SignJWT({
    client_id: params.client_id,
    scope,
    profile_id: params.profile_id,
    profiles: params.profiles,
  })
    .setProtectedHeader({ alg: "ES256", kid: params.state.kid ?? undefined, typ: "at+jwt" })
    .setIssuer(params.issuer)
    .setAudience("imessage-mcp")
    .setSubject(params.subject)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(privateKey);

  params.state.access_tokens[jti] = {
    jti,
    client_id: params.client_id,
    subject: params.subject,
    scope,
    profile_id: params.profile_id,
    profiles: params.profiles,
    exp,
    revoked: false,
    created_at: new Date().toISOString(),
  };

  const output: IssuedTokenSet = {
    access_token: token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
    profile_id: params.profile_id,
  };

  if (params.include_refresh_token) {
    const refresh = randomToken(36);
    const refreshHash = sha256(refresh);
    params.state.refresh_tokens[refreshHash] = {
      token_hash: refreshHash,
      client_id: params.client_id,
      subject: params.subject,
      scope,
      profile_id: params.profile_id,
      profiles: params.profiles,
      expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
      revoked: false,
      created_at: new Date().toISOString(),
    };
    output.refresh_token = refresh;
  }

  saveState(params.state);
  return output;
}

async function authenticateOAuthAccessToken(token: string): Promise<AuthPrincipal | null> {
  const state = await ensureStateReady();
  const publicKey = await importPublicKey(state);

  try {
    const verified = await jwtVerify(token, publicKey, {
      audience: "imessage-mcp",
    });

    const payload = verified.payload as Record<string, unknown>;
    const jti = typeof payload.jti === "string" ? payload.jti : null;
    const sub = typeof payload.sub === "string" ? payload.sub : "unknown-subject";
    const clientId = typeof payload.client_id === "string" ? payload.client_id : "oauth-client";
    const scopeRaw = typeof payload.scope === "string" ? payload.scope : "";
    const scopes = toScopeList(scopeRaw);

    const profileIdRaw = typeof payload.profile_id === "string" ? payload.profile_id : null;
    const profilesRaw = Array.isArray(payload.profiles)
      ? payload.profiles.filter((p): p is string => typeof p === "string")
      : [];

    const allowedProfiles = normalizeAllowedProfiles(
      profilesRaw.length > 0 ? profilesRaw : (profileIdRaw ? [profileIdRaw] : [getDefaultProfileId()]),
    );

    if (jti && state.revoked_jtis[jti]) {
      return null;
    }

    if (jti && state.access_tokens[jti]?.revoked) {
      return null;
    }

    return {
      auth_mode: "oauth2",
      subject: sub,
      client_id: clientId,
      scopes,
      allowed_profiles: allowedProfiles,
      active_profile: profileIdRaw || undefined,
      token_id: jti || undefined,
      is_admin: scopes.includes("admin.*") || scopes.includes("*"),
    };
  } catch {
    return null;
  }
}

export async function authenticateRequest(
  headers: Record<string, string | string[] | undefined>,
  options?: AuthenticateRequestOptions,
): Promise<AuthResult> {
  const requireAuth = options?.requireAuth ?? authRequiredByDefault();

  if (getAuthMode() === "oauth2") {
    const token = extractBearerToken(headers);
    if (!token) {
      if (!requireAuth) {
        return {
          ok: true,
          principal: {
            auth_mode: "oauth2",
            subject: "anonymous",
            client_id: "anonymous-client",
            scopes: ["*"],
            allowed_profiles: getProfileIds(),
            active_profile: getDefaultProfileId(),
            is_admin: true,
          },
        };
      }
      return bearerUnauthorized();
    }
    const principal = await authenticateOAuthAccessToken(token);
    if (!principal) return bearerUnauthorized();
    return { ok: true, principal };
  }

  const creds = normalizeBearerCredentials();
  if (creds.length === 0) {
    if (requireAuth) {
      return bearerUnauthorized();
    }
    return {
      ok: true,
      principal: {
        auth_mode: "bearer",
        subject: "anonymous",
        client_id: "anonymous-client",
        scopes: ["*"],
        allowed_profiles: getProfileIds(),
        active_profile: getDefaultProfileId(),
        is_admin: true,
      },
    };
  }

  const token = extractBearerToken(headers);
  if (!token) {
    if (!requireAuth) {
      return {
        ok: true,
        principal: {
          auth_mode: "bearer",
          subject: "anonymous",
          client_id: "anonymous-client",
          scopes: ["*"],
          allowed_profiles: getProfileIds(),
          active_profile: getDefaultProfileId(),
          is_admin: true,
        },
      };
    }
    return bearerUnauthorized();
  }

  for (const cred of creds) {
    if (safeEqualString(token, cred.token)) {
      return {
        ok: true,
        principal: principalFromBearerCredential(cred),
      };
    }
  }

  return bearerUnauthorized();
}

export interface BootstrapAdminAuthResult {
  ok: boolean;
  status: number;
  error?: string;
  principal?: AuthPrincipal;
  wwwAuthenticate?: string;
}

export function authenticateBootstrapAdmin(
  headers: Record<string, string | string[] | undefined>,
): BootstrapAdminAuthResult {
  const principal = findStaticBearerPrincipal(headers);
  if (!principal) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized",
      wwwAuthenticate: "Bearer",
    };
  }

  const required = adminScopesRequired();
  if (!hasRequiredScopes(principal.scopes, required)) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden: missing bootstrap admin scope(s): ${required.join(", ")}`,
    };
  }

  return {
    ok: true,
    status: 200,
    principal,
  };
}

export function isHttpAuthRequired(): boolean {
  return authRequiredByDefault();
}

interface AuthenticatedClient {
  client: OAuthClient;
}

function findClient(state: OAuthState, client_id: string): OAuthClient | null {
  return state.clients[client_id] ?? null;
}

async function authenticateOAuthClient(
  state: OAuthState,
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, string>,
  allowPublic = false,
): Promise<AuthenticatedClient | null> {
  const basic = parseBasicAuth(headerValue(headers, "authorization"));
  let clientId = basic?.client_id || body.client_id;
  let clientSecret = basic?.client_secret || body.client_secret;

  if (!clientId) return null;
  const client = findClient(state, clientId);
  if (!client) return null;

  const authMethod = client.token_endpoint_auth_method;
  if (authMethod === "none") {
    if (allowPublic) {
      return { client };
    }
    return null;
  }

  if (!client.client_secret_hash) return null;
  if (!clientSecret) return null;

  const provided = sha256(clientSecret);
  if (!safeEqualString(provided, client.client_secret_hash)) {
    return null;
  }

  return { client };
}

function validateRedirectUri(client: OAuthClient, redirectUri: string | undefined): string | null {
  if (!redirectUri) return null;
  if (!client.redirect_uris.includes(redirectUri)) return null;
  if (!isAllowedRedirectUri(redirectUri)) return null;
  return redirectUri;
}

function explicitRedirectAllowList(): string[] {
  return parseCsv(process.env.IMESSAGE_OAUTH_ALLOWED_REDIRECT_ORIGINS);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function allowlistedOrigin(origin: string): boolean {
  const allowlist = explicitRedirectAllowList();
  if (allowlist.length === 0) return false;
  if (allowlist.includes("*")) return true;
  return allowlist.some((allowed) => {
    const normalized = allowed.toLowerCase();
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1);
      return origin.toLowerCase().endsWith(suffix);
    }
    return origin.toLowerCase() === normalized;
  });
}

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return true;
  return allowlistedOrigin(parsed.origin);
}

function issuerFromHostHeader(host: string): string {
  const explicit = process.env.IMESSAGE_OAUTH_ISSUER?.trim();
  if (explicit) return explicit;
  return `http://${host}`;
}

function oauthMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/oauth/jwks.json`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: DEFAULT_SCOPE_SET,
  };
}

function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function clientMetadataResponse(
  issuer: string,
  client: OAuthClient,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    scope: client.scope,
    registration_client_uri: `${issuer}/oauth/register/${client.client_id}`,
    imessage_profiles: client.allowed_profiles,
    ...(extras || {}),
  };
}

function parseClientMetadata(input: {
  body: Record<string, string>;
  parsedJson: any;
}): {
  redirect_uris: string[];
  token_auth_method: OAuthClient["token_endpoint_auth_method"];
  grant_types: string[];
  allowed_scopes: string[];
  requested_profiles: string[];
  client_name?: string;
} {
  const redirectUris = Array.isArray(input.parsedJson?.redirect_uris)
    ? input.parsedJson.redirect_uris.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("http"))
    : [];

  const invalidRedirect = redirectUris.find((uri: string) => !isAllowedRedirectUri(uri));
  if (invalidRedirect) {
    throw new Error(`redirect_uri not allowed: ${invalidRedirect}`);
  }

  const tokenAuthMethod = (input.parsedJson?.token_endpoint_auth_method || input.body.token_endpoint_auth_method || "client_secret_basic") as OAuthClient["token_endpoint_auth_method"];
  if (!["none", "client_secret_basic", "client_secret_post"].includes(tokenAuthMethod)) {
    throw new Error("Unsupported token_endpoint_auth_method");
  }

  const grantTypes = Array.isArray(input.parsedJson?.grant_types)
    ? input.parsedJson.grant_types.filter((g: unknown): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token", "client_credentials"];

  const requestedScope =
    typeof input.parsedJson?.scope === "string" ? input.parsedJson.scope : input.body.scope;
  const allowedScopes = ensureKnownScopes(toScopeList(requestedScope));

  const requestedProfiles = Array.isArray(input.parsedJson?.imessage_profiles)
    ? input.parsedJson.imessage_profiles.filter((p: unknown): p is string => typeof p === "string")
    : [];

  return {
    redirect_uris: redirectUris,
    token_auth_method: tokenAuthMethod,
    grant_types: grantTypes,
    allowed_scopes: allowedScopes,
    requested_profiles: requestedProfiles,
    client_name: typeof input.parsedJson?.client_name === "string" ? input.parsedJson.client_name : undefined,
  };
}

function createRegistrationAccessToken(state: OAuthState, clientId: string): string {
  const token = randomToken(40);
  const hash = sha256(token);
  state.registration_access_tokens[hash] = {
    token_hash: hash,
    client_id: clientId,
    created_at: new Date().toISOString(),
    revoked: false,
  };
  return token;
}

function authenticateRegistrationAccessToken(
  state: OAuthState,
  headers: Record<string, string | string[] | undefined>,
  clientId: string,
): boolean {
  const token = extractBearerToken(headers);
  if (!token) return false;
  const meta = state.registration_access_tokens[sha256(token)];
  if (!meta || meta.revoked) return false;
  return meta.client_id === clientId;
}

async function handleRegister(
  req: HttpLikeRequest,
  res: HttpLikeResponse,
  issuer: string,
  bootstrapPrincipal: AuthPrincipal,
): Promise<void> {
  const bodyRaw = await readBody(req);
  const contentType = headerValue(req.headers, "content-type") || "application/json";
  const body = parseBodyParams(contentType, bodyRaw);

  let parsedJson: any = null;
  if (contentType.includes("application/json")) {
    try {
      parsedJson = JSON.parse(bodyRaw);
    } catch {
      parsedJson = null;
    }
  }

  const state = await ensureStateReady();
  let metadata;
  try {
    metadata = parseClientMetadata({ body, parsedJson });
  } catch (err) {
    oauthError(res, 400, "invalid_client_metadata", err instanceof Error ? err.message : String(err));
    return;
  }

  const requestedProfiles = normalizeAllowedProfiles(metadata.requested_profiles);
  const allowedProfiles = bootstrapPrincipal.allowed_profiles.includes("*")
    ? requestedProfiles
    : requestedProfiles.filter((profile) => bootstrapPrincipal.allowed_profiles.includes(profile));
  if (allowedProfiles.length === 0) {
    oauthError(res, 400, "invalid_client_metadata", "No valid profiles available for this registration");
    return;
  }

  if (metadata.grant_types.includes("authorization_code") && metadata.redirect_uris.length === 0) {
    oauthError(res, 400, "invalid_client_metadata", "redirect_uris required for authorization_code grant");
    return;
  }

  const clientId = `imessage-${randomToken(12)}`;
  const clientSecret = metadata.token_auth_method === "none" ? null : randomToken(24);

  const client: OAuthClient = {
    client_id: clientId,
    client_secret_hash: clientSecret ? sha256(clientSecret) : null,
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
    token_endpoint_auth_method: metadata.token_auth_method,
    grant_types: metadata.grant_types,
    response_types: ["code"],
    scope: metadata.allowed_scopes.join(" "),
    allowed_scopes: metadata.allowed_scopes,
    allowed_profiles: allowedProfiles,
    created_at: new Date().toISOString(),
  };

  const registrationAccessToken = createRegistrationAccessToken(state, clientId);
  state.clients[clientId] = client;
  saveState(state);

  const response = clientMetadataResponse(issuer, client, {
    client_id_issued_at: Math.floor(Date.now() / 1000),
    registration_access_token: registrationAccessToken,
    bootstrap_subject: bootstrapPrincipal.subject,
  });

  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0;
  }

  json(res, 201, response);
}

async function handleAuthorize(
  req: HttpLikeRequest,
  res: HttpLikeResponse,
  url: URL,
  bootstrapPrincipal: AuthPrincipal,
): Promise<void> {
  const state = await ensureStateReady();

  const q = url.searchParams;
  const responseType = q.get("response_type") || "";
  const clientId = q.get("client_id") || "";
  const redirectUri = q.get("redirect_uri") || "";
  const stateParam = q.get("state") || undefined;
  const requestedScope = q.get("scope") || "";
  const codeChallenge = q.get("code_challenge") || "";
  const codeChallengeMethod = (q.get("code_challenge_method") || "S256").toUpperCase();
  const requestedProfile = q.get("profile") || undefined;
  const approve = (q.get("approve") || "").toLowerCase();
  const subject = bootstrapPrincipal.subject;

  const client = findClient(state, clientId);
  if (!client) {
    oauthError(res, 400, "unauthorized_client", "Unknown client_id");
    return;
  }

  const redirect = validateRedirectUri(client, redirectUri);
  if (!redirect) {
    oauthError(res, 400, "invalid_request", "Invalid redirect_uri");
    return;
  }

  if (responseType !== "code") {
    redirectWithParams(res, redirect, {
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
      state: stateParam,
    });
    return;
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    redirectWithParams(res, redirect, {
      error: "invalid_request",
      error_description: "PKCE with code_challenge_method=S256 is required",
      state: stateParam,
    });
    return;
  }

  const requestedScopes = toScopeList(requestedScope);
  const grantedScopes = selectGrantedScopes(requestedScopes, client.allowed_scopes);
  if (grantedScopes.length === 0) {
    redirectWithParams(res, redirect, {
      error: "invalid_scope",
      error_description: "No allowed scopes requested",
      state: stateParam,
    });
    return;
  }

  let resolvedProfile = "";
  try {
    const profileScope = bootstrapPrincipal.allowed_profiles.includes("*")
      ? client.allowed_profiles
      : client.allowed_profiles.filter((profile) => bootstrapPrincipal.allowed_profiles.includes(profile));
    resolvedProfile = resolveAllowedProfileId(requestedProfile, profileScope);
  } catch (err) {
    redirectWithParams(res, redirect, {
      error: "invalid_target",
      error_description: err instanceof Error ? err.message : String(err),
      state: stateParam,
    });
    return;
  }

  if (!OAUTH_AUTO_APPROVE && req.method === "GET" && approve !== "1" && approve !== "true") {
    const approveUrl = new URL(url.toString());
    approveUrl.searchParams.set("approve", "1");
    const denyUrl = new URL(url.toString());
    denyUrl.searchParams.set("approve", "0");

    html(
      res,
      200,
      `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Authorize iMessage MCP</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 760px; margin: 40px auto;">
    <h1>Authorize ${client.client_name || client.client_id}</h1>
    <p><strong>Subject:</strong> ${subject}</p>
    <p><strong>Profile:</strong> ${resolvedProfile}</p>
    <p><strong>Scopes:</strong> ${grantedScopes.join(", ")}</p>
    <p>
      <a href="${approveUrl.toString()}">Approve</a>
      &nbsp;|&nbsp;
      <a href="${denyUrl.toString()}">Deny</a>
    </p>
  </body>
</html>`,
    );
    return;
  }

  if (approve === "0" || approve === "false" || approve === "deny") {
    redirectWithParams(res, redirect, {
      error: "access_denied",
      state: stateParam,
    });
    return;
  }

  const code = randomToken(30);
  const codeHash = sha256(code);
  const now = Math.floor(Date.now() / 1000);

  state.auth_codes[codeHash] = {
    code_hash: codeHash,
    client_id: client.client_id,
    redirect_uri: redirect,
    scope: grantedScopes.join(" "),
    subject,
    profile_id: resolvedProfile,
    profiles: client.allowed_profiles,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    expires_at: now + AUTH_CODE_TTL_SECONDS,
    used: false,
    created_at: new Date().toISOString(),
  };
  saveState(state);

  redirectWithParams(res, redirect, {
    code,
    state: stateParam,
  });
}

async function handleToken(req: HttpLikeRequest, res: HttpLikeResponse, issuer: string): Promise<void> {
  const raw = await readBody(req);
  const contentType = headerValue(req.headers, "content-type") || "application/x-www-form-urlencoded";
  const body = parseBodyParams(contentType, raw);
  const grantType = body.grant_type || "";

  const state = await ensureStateReady();

  if (grantType === "authorization_code") {
    const authed = await authenticateOAuthClient(state, req.headers, body, true);
    if (!authed) {
      oauthError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }

    const code = body.code;
    const redirectUri = body.redirect_uri;
    const verifier = body.code_verifier;

    if (!code || !redirectUri || !verifier) {
      oauthError(res, 400, "invalid_request", "code, redirect_uri, and code_verifier are required");
      return;
    }

    const codeHash = sha256(code);
    const record = state.auth_codes[codeHash];
    if (!record || record.used) {
      oauthError(res, 400, "invalid_grant", "Invalid authorization code");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (record.expires_at <= now) {
      delete state.auth_codes[codeHash];
      saveState(state);
      oauthError(res, 400, "invalid_grant", "Authorization code expired");
      return;
    }

    if (record.client_id !== authed.client.client_id) {
      oauthError(res, 400, "invalid_grant", "authorization code was not issued to this client");
      return;
    }

    if (record.redirect_uri !== redirectUri) {
      oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
      return;
    }

    const expectedChallenge = pkceChallengeFromVerifier(verifier);
    if (!safeEqualString(expectedChallenge, record.code_challenge)) {
      oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }

    record.used = true;

    const scopeList = toScopeList(record.scope);
    const tokenSet = await issueTokens({
      state,
      issuer,
      client_id: authed.client.client_id,
      subject: record.subject,
      scopeList,
      profile_id: record.profile_id,
      profiles: record.profiles,
      include_refresh_token: true,
    });

    delete state.auth_codes[codeHash];
    saveState(state);

    json(res, 200, tokenSet);
    return;
  }

  if (grantType === "refresh_token") {
    const authed = await authenticateOAuthClient(state, req.headers, body, true);
    if (!authed) {
      oauthError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }

    const refresh = body.refresh_token;
    if (!refresh) {
      oauthError(res, 400, "invalid_request", "refresh_token is required");
      return;
    }

    const hash = sha256(refresh);
    const record = state.refresh_tokens[hash];
    if (!record || record.revoked) {
      oauthError(res, 400, "invalid_grant", "Invalid refresh_token");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (record.expires_at <= now) {
      delete state.refresh_tokens[hash];
      saveState(state);
      oauthError(res, 400, "invalid_grant", "refresh_token expired");
      return;
    }

    if (record.client_id !== authed.client.client_id) {
      oauthError(res, 400, "invalid_grant", "refresh_token was not issued to this client");
      return;
    }

    const requestedScopes = toScopeList(body.scope);
    const scopes = requestedScopes.length > 0
      ? selectGrantedScopes(requestedScopes, toScopeList(record.scope))
      : toScopeList(record.scope);

    record.revoked = true; // rotation

    const tokenSet = await issueTokens({
      state,
      issuer,
      client_id: record.client_id,
      subject: record.subject,
      scopeList: scopes,
      profile_id: record.profile_id,
      profiles: record.profiles,
      include_refresh_token: true,
    });

    saveState(state);
    json(res, 200, tokenSet);
    return;
  }

  if (grantType === "client_credentials") {
    const authed = await authenticateOAuthClient(state, req.headers, body, false);
    if (!authed) {
      oauthError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }

    if (!authed.client.grant_types.includes("client_credentials")) {
      oauthError(res, 400, "unauthorized_client", "client_credentials grant not allowed for this client");
      return;
    }

    const requestedScopes = toScopeList(body.scope);
    const scopes = selectGrantedScopes(requestedScopes, authed.client.allowed_scopes);
    if (scopes.length === 0) {
      oauthError(res, 400, "invalid_scope", "No allowed scopes requested");
      return;
    }

    let profileId = "";
    try {
      profileId = resolveAllowedProfileId(body.profile, authed.client.allowed_profiles);
    } catch (err) {
      oauthError(res, 400, "invalid_target", err instanceof Error ? err.message : String(err));
      return;
    }

    const tokenSet = await issueTokens({
      state,
      issuer,
      client_id: authed.client.client_id,
      subject: `client:${authed.client.client_id}`,
      scopeList: scopes,
      profile_id: profileId,
      profiles: authed.client.allowed_profiles,
      include_refresh_token: false,
    });

    json(res, 200, tokenSet);
    return;
  }

  oauthError(res, 400, "unsupported_grant_type", "Supported grant_types: authorization_code, refresh_token, client_credentials");
}

function tokenMetaFromState(state: OAuthState, jti: string): OAuthAccessTokenMeta | null {
  const meta = state.access_tokens[jti];
  return meta || null;
}

async function introspectToken(state: OAuthState, token: string): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);

  // Refresh token introspection (opaque)
  const refresh = state.refresh_tokens[sha256(token)];
  if (refresh) {
    const active = !refresh.revoked && refresh.expires_at > now;
    return {
      active,
      client_id: refresh.client_id,
      sub: refresh.subject,
      scope: refresh.scope,
      token_type: "refresh_token",
      exp: refresh.expires_at,
      profile_id: refresh.profile_id,
      profiles: refresh.profiles,
    };
  }

  // Access token introspection (JWT)
  try {
    const claims = decodeJwt(token) as Record<string, unknown>;
    const jti = typeof claims.jti === "string" ? claims.jti : null;
    const exp = typeof claims.exp === "number" ? claims.exp : 0;

    if (!jti || exp <= now) {
      return { active: false };
    }

    const meta = tokenMetaFromState(state, jti);
    if (!meta || meta.revoked || state.revoked_jtis[jti]) {
      return { active: false };
    }

    return {
      active: true,
      scope: meta.scope,
      client_id: meta.client_id,
      sub: meta.subject,
      exp: meta.exp,
      token_type: "access_token",
      profile_id: meta.profile_id,
      profiles: meta.profiles,
      jti,
    };
  } catch {
    return { active: false };
  }
}

async function handleIntrospect(req: HttpLikeRequest, res: HttpLikeResponse): Promise<void> {
  const raw = await readBody(req);
  const contentType = headerValue(req.headers, "content-type") || "application/x-www-form-urlencoded";
  const body = parseBodyParams(contentType, raw);

  const state = await ensureStateReady();
  const authed = await authenticateOAuthClient(state, req.headers, body, false);
  if (!authed) {
    oauthError(res, 401, "invalid_client", "Client authentication failed");
    return;
  }

  const token = body.token;
  if (!token) {
    oauthError(res, 400, "invalid_request", "token is required");
    return;
  }

  const result = await introspectToken(state, token);
  json(res, 200, result);
}

async function handleRevoke(req: HttpLikeRequest, res: HttpLikeResponse): Promise<void> {
  const raw = await readBody(req);
  const contentType = headerValue(req.headers, "content-type") || "application/x-www-form-urlencoded";
  const body = parseBodyParams(contentType, raw);

  const state = await ensureStateReady();
  const authed = await authenticateOAuthClient(state, req.headers, body, false);
  if (!authed) {
    oauthError(res, 401, "invalid_client", "Client authentication failed");
    return;
  }

  const token = body.token;
  if (!token) {
    oauthError(res, 400, "invalid_request", "token is required");
    return;
  }

  // Opaque refresh token
  const refreshHash = sha256(token);
  if (state.refresh_tokens[refreshHash]) {
    state.refresh_tokens[refreshHash].revoked = true;
    saveState(state);
    json(res, 200, {});
    return;
  }

  // Access token JWT
  try {
    const claims = decodeJwt(token) as Record<string, unknown>;
    const jti = typeof claims.jti === "string" ? claims.jti : null;
    const exp = typeof claims.exp === "number" ? claims.exp : Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    if (jti) {
      state.revoked_jtis[jti] = exp;
      if (state.access_tokens[jti]) {
        state.access_tokens[jti].revoked = true;
      }
      saveState(state);
    }
  } catch {
    // RFC 7009: revoke is idempotent; unknown token still returns success.
  }

  json(res, 200, {});
}

function revokeRegistrationTokensForClient(state: OAuthState, clientId: string): void {
  for (const [hash, meta] of Object.entries(state.registration_access_tokens)) {
    if (meta.client_id === clientId) {
      meta.revoked = true;
      state.registration_access_tokens[hash] = meta;
    }
  }
}

function revokeClientArtifacts(state: OAuthState, clientId: string): void {
  for (const [hash, code] of Object.entries(state.auth_codes)) {
    if (code.client_id === clientId) {
      delete state.auth_codes[hash];
    }
  }
  for (const [hash, refresh] of Object.entries(state.refresh_tokens)) {
    if (refresh.client_id === clientId) {
      refresh.revoked = true;
    }
  }
  for (const [jti, access] of Object.entries(state.access_tokens)) {
    if (access.client_id === clientId) {
      access.revoked = true;
      state.revoked_jtis[jti] = access.exp;
    }
  }
  revokeRegistrationTokensForClient(state, clientId);
}

function extractRegistrationClientId(pathname: string): string | null {
  const prefix = "/oauth/register/";
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length).trim();
  if (!value) return null;
  return decodeURIComponent(value);
}

async function handleRegisterClientUri(
  req: HttpLikeRequest,
  res: HttpLikeResponse,
  url: URL,
  issuer: string,
): Promise<void> {
  const clientId = extractRegistrationClientId(url.pathname);
  if (!clientId) {
    oauthError(res, 400, "invalid_request", "Missing client id");
    return;
  }

  const state = await ensureStateReady();
  const client = findClient(state, clientId);
  if (!client) {
    oauthError(res, 404, "invalid_client", "Unknown client_id");
    return;
  }

  if (!authenticateRegistrationAccessToken(state, req.headers, clientId)) {
    oauthError(res, 401, "invalid_token", "Registration access token required");
    return;
  }

  if (req.method === "GET") {
    json(res, 200, clientMetadataResponse(issuer, client));
    return;
  }

  if (req.method === "PUT") {
    const bodyRaw = await readBody(req);
    const contentType = headerValue(req.headers, "content-type") || "application/json";
    const body = parseBodyParams(contentType, bodyRaw);

    let parsedJson: any = null;
    if (contentType.includes("application/json")) {
      try {
        parsedJson = JSON.parse(bodyRaw);
      } catch {
        parsedJson = null;
      }
    }

    let metadata;
    try {
      metadata = parseClientMetadata({ body, parsedJson });
    } catch (err) {
      oauthError(res, 400, "invalid_client_metadata", err instanceof Error ? err.message : String(err));
      return;
    }

    const allowedProfiles = normalizeAllowedProfiles(metadata.requested_profiles);
    if (allowedProfiles.length === 0) {
      oauthError(res, 400, "invalid_client_metadata", "No valid profiles available for this client");
      return;
    }
    if (metadata.grant_types.includes("authorization_code") && metadata.redirect_uris.length === 0) {
      oauthError(res, 400, "invalid_client_metadata", "redirect_uris required for authorization_code grant");
      return;
    }

    let generatedSecret: string | null = null;
    if (metadata.token_auth_method === "none") {
      client.client_secret_hash = null;
    } else if (!client.client_secret_hash) {
      generatedSecret = randomToken(24);
      client.client_secret_hash = sha256(generatedSecret);
    }

    client.client_name = metadata.client_name;
    client.redirect_uris = metadata.redirect_uris;
    client.token_endpoint_auth_method = metadata.token_auth_method;
    client.grant_types = metadata.grant_types;
    client.allowed_scopes = metadata.allowed_scopes;
    client.scope = metadata.allowed_scopes.join(" ");
    client.allowed_profiles = allowedProfiles;

    saveState(state);

    const response = clientMetadataResponse(issuer, client);
    if (generatedSecret) {
      response.client_secret = generatedSecret;
      response.client_secret_expires_at = 0;
    }
    json(res, 200, response);
    return;
  }

  if (req.method === "DELETE") {
    revokeClientArtifacts(state, clientId);
    delete state.clients[clientId];
    saveState(state);
    res.writeHead(204);
    res.end();
    return;
  }

  oauthError(res, 405, "invalid_request", "Method not allowed");
}

export async function maybeHandleOAuthRequest(
  req: HttpLikeRequest,
  res: HttpLikeResponse,
  url: URL,
  hostHeader: string,
): Promise<boolean> {
  if (getAuthMode() !== "oauth2") return false;

  const issuer = issuerFromHostHeader(hostHeader);

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    json(res, 200, oauthMetadata(issuer));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    json(res, 200, oauthMetadata(issuer));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/jwks.json") {
    const state = await ensureStateReady();
    json(res, 200, {
      keys: state.public_jwk ? [state.public_jwk] : [],
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    const bootstrap = authenticateBootstrapAdmin(req.headers);
    if (!bootstrap.ok || !bootstrap.principal) {
      const headers = bootstrap.wwwAuthenticate ? { "WWW-Authenticate": bootstrap.wwwAuthenticate } : undefined;
      json(res, bootstrap.status, { error: bootstrap.error || "Unauthorized" }, headers);
      return true;
    }
    await handleRegister(req, res, issuer, bootstrap.principal);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    const bootstrap = authenticateBootstrapAdmin(req.headers);
    if (!bootstrap.ok || !bootstrap.principal) {
      const headers = bootstrap.wwwAuthenticate ? { "WWW-Authenticate": bootstrap.wwwAuthenticate } : undefined;
      json(res, bootstrap.status, { error: bootstrap.error || "Unauthorized" }, headers);
      return true;
    }
    await handleAuthorize(req, res, url, bootstrap.principal);
    return true;
  }

  if ((req.method === "GET" || req.method === "PUT" || req.method === "DELETE") && url.pathname.startsWith("/oauth/register/")) {
    await handleRegisterClientUri(req, res, url, issuer);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    await handleToken(req, res, issuer);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/introspect") {
    await handleIntrospect(req, res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/revoke") {
    await handleRevoke(req, res);
    return true;
  }

  return false;
}

export function authModeLabel(): AuthMode {
  return getAuthMode();
}
