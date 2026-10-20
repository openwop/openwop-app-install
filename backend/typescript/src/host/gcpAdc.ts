/**
 * The ONE GCP metadata-server client (ADR 0904 P1b / D12, architect X1; used by ADR 0906).
 *
 * On Cloud Run the host's own service identity is read from the metadata
 * server: an OAuth access token plus a few instance facts (project id,
 * region). Four call sites used to fetch these independently, and only one of
 * them cached the token until expiry. They now all come here, and
 * `test/gcp-adc-single-fetcher-ratchet.test.ts` refuses a fifth.
 *
 * The metadata fetch goes DIRECT, never through `guardedEgressFetch`: the
 * metadata host is on the SSRF blocklist (`webhookEgressGuard.ts`) precisely so
 * that user-supplied URLs cannot reach it. The `*.googleapis.com` calls made
 * with the token stay behind the guard at each caller.
 *
 * No stored credentials: off GCP the metadata server is absent and every call
 * throws `GcpMetadataError`, which callers map to their own "not configured"
 * outcome.
 */

export const GCP_METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1';
const TOKEN_PATH = 'instance/service-accounts/default/token';
/** The default service account's token endpoint (exported for callers' test fakes). */
export const GCP_METADATA_TOKEN_URL = `${GCP_METADATA_BASE}/${TOKEN_PATH}`;

/** Refresh this long before the token's stated expiry, so it never lapses mid-call. */
const REFRESH_EARLY_MS = 60_000;
/** Used when the server omits a usable `expires_in`. */
const FALLBACK_TTL_MS = 60_000;

export class GcpMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GcpMetadataError';
  }
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GcpMetadataClient {
  /** The default service account's access token, cached until a minute before expiry. */
  accessToken(signal?: AbortSignal): Promise<string>;
  /** A plain-text metadata value, e.g. `project/project-id` or `instance/region`. */
  metadataText(path: string, signal?: AbortSignal): Promise<string>;
  /** Drop the cached token — call after a 401/403 so the next call mints a fresh one. */
  invalidate(): void;
}

export function createGcpMetadataClient(deps: { fetchImpl?: FetchLike; now?: () => number } = {}): GcpMetadataClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  let cached: { value: string; expiresAt: number } | null = null;

  const metadataText = async (path: string, signal?: AbortSignal): Promise<string> => {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${GCP_METADATA_BASE}/${path}`, { headers: { 'Metadata-Flavor': 'Google' }, ...(signal ? { signal } : {}) });
    } catch (err) {
      throw new GcpMetadataError(`metadata ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      await res.text().catch(() => ''); // drain so the socket is reused
      throw new GcpMetadataError(`metadata ${path}: HTTP ${res.status}`);
    }
    return (await res.text()).trim();
  };

  return {
    metadataText,
    invalidate(): void { cached = null; },
    async accessToken(signal?: AbortSignal): Promise<string> {
      const t = now();
      if (cached && cached.expiresAt > t) return cached.value;
      let body: unknown;
      try { body = JSON.parse(await metadataText(TOKEN_PATH, signal)); } catch (err) {
        if (err instanceof GcpMetadataError) throw err;
        throw new GcpMetadataError('metadata token: response was not JSON');
      }
      const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const value = rec['access_token'];
      if (typeof value !== 'string' || value === '') throw new GcpMetadataError('metadata token: no access_token');
      const expiresIn = rec['expires_in'];
      const ttlMs = typeof expiresIn === 'number' && expiresIn * 1000 > 2 * REFRESH_EARLY_MS
        ? expiresIn * 1000 - REFRESH_EARLY_MS
        : FALLBACK_TTL_MS;
      cached = { value, expiresAt: t + ttlMs };
      return value;
    },
  };
}

let shared: GcpMetadataClient | null = null;

/** The process-wide client, so every caller shares one cached token. */
export function gcpMetadata(): GcpMetadataClient {
  shared ??= createGcpMetadataClient();
  return shared;
}

/** Test-only: drop the shared client (and its cached token). */
export function __resetGcpMetadataForTests(): void {
  shared = null;
}
