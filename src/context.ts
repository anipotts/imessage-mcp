// Request-scoped context (principal + profile binding) used by tools,
// cursor state, DB selection, and ACL checks.

import { AsyncLocalStorage } from "node:async_hooks";
import { getProfile, resolveAllowedProfileId } from "./profiles.js";

export type AuthMode = "stdio" | "bearer" | "oauth2";

export interface AuthPrincipal {
  auth_mode: AuthMode;
  subject: string;
  client_id: string;
  scopes: string[];
  allowed_profiles: string[];
  active_profile?: string;
  token_id?: string;
  is_admin?: boolean;
}

export interface RequestContext {
  principal: AuthPrincipal | null;
  profile_id: string;
  db_path: string;
  session_id?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | null {
  return requestContextStorage.getStore() ?? null;
}

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStorage.run(ctx, fn);
}

export function withRequestContextAsync<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(ctx, fn);
}

export function resolveRequestContext(
  principal: AuthPrincipal | null,
  requestedProfile: string | null | undefined,
  sessionId?: string,
): RequestContext {
  const profileId = resolveAllowedProfileId(
    requestedProfile,
    principal?.allowed_profiles,
  );

  const profile = getProfile(profileId);
  return {
    principal,
    profile_id: profile.id,
    db_path: profile.db_path,
    session_id: sessionId,
  };
}

export function isAdminPrincipal(principal: AuthPrincipal | null | undefined): boolean {
  if (!principal) return true; // stdio/local context has full access
  return Boolean(principal.is_admin || principal.scopes.includes("*") || principal.scopes.includes("admin.*"));
}

export function getPrincipalSubject(): string | null {
  return getRequestContext()?.principal?.subject ?? null;
}
