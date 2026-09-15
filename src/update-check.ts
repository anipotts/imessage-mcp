// A version lookup for server_status and doctor. It sends one anonymous GET to
// the public npm registry, carries no identifiers or message data, and is off
// when IMESSAGE_UPDATE_CHECK=0.

export const LATEST_BUNDLE_URL = "https://github.com/anipotts/imessage-mcp/releases/latest/download/imessage-mcp.mcpb";
const LATEST_METADATA_URL = "https://registry.npmjs.org/imessage-mcp/latest";
const WAIT_MS = 1_500;
const MAX_RESPONSE_BYTES = 256 * 1024;
const FOUND_TTL_MS = 12 * 60 * 60 * 1000;
const FAILED_TTL_MS = 10 * 60 * 1000;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u;

export interface UpdateState {
  status: "current" | "available" | "unknown" | "disabled";
  current_version: string;
  latest_version?: string;
  // Present only when status is "available".
  download_url?: string;
  how_to_update?: string;
}

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

let cached: { expires: number; latest: string | null } | null = null;
let inflight: Promise<string | null> | null = null;

export function updateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // "false" is what Claude Desktop passes when its settings toggle is off.
  return env.IMESSAGE_UPDATE_CHECK !== "0" && env.IMESSAGE_UPDATE_CHECK !== "false";
}

// Compares stable x.y.z versions; a prerelease or malformed current version is
// never told to "update" to a stable release it may already be ahead of.
export function isNewer(latest: string, current: string): boolean {
  const next = VERSION.exec(latest);
  const running = VERSION.exec(current);
  if (!next || !running) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(next[index]) - Number(running[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

async function fetchLatest(fetchImpl: Fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(LATEST_METADATA_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) return null;
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === "string" && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(
  currentVersion: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: Fetch; now?: () => number; waitMs?: number } = {},
): Promise<UpdateState> {
  if (!updateCheckEnabled(options.env)) return { status: "disabled", current_version: currentVersion };
  const now = options.now ?? Date.now;
  if (!cached || cached.expires <= now()) {
    inflight ??= fetchLatest(options.fetch ?? (fetch as Fetch)).then((latest) => {
      cached = { expires: now() + (latest ? FOUND_TTL_MS : FAILED_TTL_MS), latest };
      inflight = null;
      return latest;
    });
    // A slow registry must not hold up the tool; the lookup keeps running and
    // the next call reads its result.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      inflight,
      new Promise((resolve) => {
        timer = setTimeout(resolve, options.waitMs ?? WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }
  const latest = cached && cached.expires > now() ? cached.latest : null;
  if (!latest) return { status: "unknown", current_version: currentVersion };
  if (!isNewer(latest, currentVersion)) {
    return { status: "current", current_version: currentVersion, latest_version: latest };
  }
  return {
    status: "available",
    current_version: currentVersion,
    latest_version: latest,
    download_url: LATEST_BUNDLE_URL,
    how_to_update: "npx installs: restart the client (change a pinned imessage-mcp@2 to imessage-mcp@latest). Claude Desktop: open download_url and install the bundle over the old one.",
  };
}

export function resetUpdateCheckForTests(): void {
  cached = null;
  inflight = null;
}
