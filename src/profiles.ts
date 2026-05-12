// Runtime profile configuration for multi-user/shared deployments.
//
// Profiles map logical namespaces (e.g. personal/work/household members)
// to isolated chat.db paths.

import { homedir } from "node:os";
import path from "node:path";

export interface ProfileConfig {
  id: string;
  db_path: string;
  label?: string;
}

type RawProfile =
  | string
  | {
      db?: string;
      db_path?: string;
      label?: string;
    };

const DEFAULT_DB = path.join(homedir(), "Library/Messages/chat.db");

let cachedProfiles: ProfileConfig[] | null = null;
let cachedById: Map<string, ProfileConfig> | null = null;
let cachedDefaultProfileId: string | null = null;

function parseProfilesEnv(): Record<string, RawProfile> | null {
  const raw = process.env.IMESSAGE_PROFILES;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object keyed by profile id");
    }
    return parsed as Record<string, RawProfile>;
  } catch (err) {
    process.stderr.write(`[profiles] Invalid IMESSAGE_PROFILES JSON: ${err}\n`);
    return null;
  }
}

function normalizeProfile(id: string, raw: RawProfile): ProfileConfig | null {
  const cleanId = id.trim();
  if (!cleanId) return null;

  if (typeof raw === "string") {
    const dbPath = raw.trim();
    if (!dbPath) return null;
    return { id: cleanId, db_path: dbPath };
  }

  if (!raw || typeof raw !== "object") return null;
  const dbPath = String(raw.db_path ?? raw.db ?? "").trim();
  if (!dbPath) return null;

  const label = raw.label?.trim() || undefined;
  return {
    id: cleanId,
    db_path: dbPath,
    label,
  };
}

function buildProfiles(): ProfileConfig[] {
  const fromEnv = parseProfilesEnv();
  if (fromEnv) {
    const profiles: ProfileConfig[] = [];
    for (const [id, raw] of Object.entries(fromEnv)) {
      const normalized = normalizeProfile(id, raw);
      if (!normalized) {
        process.stderr.write(`[profiles] Skipping invalid profile \"${id}\"\n`);
        continue;
      }
      profiles.push(normalized);
    }

    if (profiles.length > 0) {
      return profiles;
    }

    process.stderr.write("[profiles] No valid profiles parsed from IMESSAGE_PROFILES; using default profile\n");
  }

  return [
    {
      id: "default",
      db_path: process.env.IMESSAGE_DB?.trim() || DEFAULT_DB,
      label: "Default",
    },
  ];
}

function ensureCache(): void {
  if (cachedProfiles && cachedById && cachedDefaultProfileId) return;

  cachedProfiles = buildProfiles();
  cachedById = new Map(cachedProfiles.map((p) => [p.id, p]));

  const configuredDefault = process.env.IMESSAGE_DEFAULT_PROFILE?.trim();
  if (configuredDefault && cachedById.has(configuredDefault)) {
    cachedDefaultProfileId = configuredDefault;
  } else {
    cachedDefaultProfileId = cachedProfiles[0].id;
  }
}

export function getProfiles(): ProfileConfig[] {
  ensureCache();
  return [...cachedProfiles!];
}

export function getProfileIds(): string[] {
  ensureCache();
  return cachedProfiles!.map((p) => p.id);
}

export function getDefaultProfileId(): string {
  ensureCache();
  return cachedDefaultProfileId!;
}

export function getProfile(id?: string | null): ProfileConfig {
  ensureCache();

  const resolvedId = (id || getDefaultProfileId()).trim();
  const profile = cachedById!.get(resolvedId);
  if (!profile) {
    const known = getProfileIds().join(", ");
    throw new Error(`Unknown profile \"${resolvedId}\". Known profiles: ${known}`);
  }
  return profile;
}

export function resolveAllowedProfileId(
  requestedProfile: string | null | undefined,
  allowedProfileIds?: string[],
): string {
  const requested = requestedProfile?.trim();

  let allowed = allowedProfileIds?.filter(Boolean) ?? [];
  if (allowed.length === 0 || allowed.includes("*")) {
    allowed = getProfileIds();
  }

  if (requested) {
    if (!allowed.includes(requested)) {
      throw new Error(`Profile \"${requested}\" is not allowed for this principal`);
    }
    return requested;
  }

  const preferred = getDefaultProfileId();
  if (allowed.includes(preferred)) return preferred;
  if (allowed.length > 0) return allowed[0];

  throw new Error("No profile available for this principal");
}

export function isProfileConfigured(id: string): boolean {
  ensureCache();
  return cachedById!.has(id);
}
