/**
 * Knowledge-source fetch (ADR 0038 follow-on — "Connections as ingestion
 * sources"). Pulls a document's text from the ACTING USER's connected provider
 * so it can be ingested into a per-agent knowledge collection, WITHOUT manual
 * copy/paste.
 *
 * Composes the existing primitives — NO new egress path, NO new store:
 *   - the Connections broker + `brokeredFetch` (host/brokeredEgress) — SSRF-
 *     guarded, `apiHosts`-pinned, per-(tenant, provider, actingUser) token
 *     resolution; a bad ref can never widen egress beyond the provider's hosts.
 *   - the caller then hands the returned text to `kbService.ingestDocument`
 *     (ADR 0011) — chunk → embed → cite.
 *
 * Google Drive is the first provider (per the /architect Option 3 landing: ship
 * the concrete fetch operation per-provider; the per-provider switch below is the
 * seed the deferred ADR 0037 named-operation descriptor catalog later subsumes —
 * adding a provider is one `case`, not a new framework).
 *
 * Read-only. The brokered call uses a synthetic runId for provenance only; the
 * credential is resolved by (tenantId, provider, actingUserId) — a missing
 * connection fails closed (`credential_required`), never a silent empty ingest.
 *
 * @see docs/adr/0038-per-agent-knowledge-memory.md §"Follow-on: Connections-as-ingestion"
 * @see src/host/connectorInvoker.ts — the brokeredFetch composition this mirrors
 */

import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { brokeredFetch } from './brokeredEgress.js';

/** A fetched source ready for `kbService.ingestDocument({ title, text })`. */
export interface FetchedSource {
  title: string;
  text: string;
  /** The provider-API URL the text was read from (for the document's audit trail). */
  sourceUrl: string;
}

export interface KnowledgeFetchDeps {
  storage: Storage;
  tenantId: string;
  /** The acting human whose provider Connection is used. REQUIRED — a system
   *  (no-user) caller has no connection and fails closed. */
  actingUserId: string;
  orgId?: string;
}

/** Cap a single source fetch so an ingest can't pull an unbounded blob. */
const MAX_FETCH_BYTES = 2_000_000;
/** Provenance-only run id for the brokered call (this is a user curation action,
 *  not a workflow run). The broker resolves the credential by tenant+provider+
 *  user, not by run, so this never affects auth. */
const SYNTHETIC_RUN_ID = 'host:agent-knowledge-ingest';

/** Lower-cased provider ids this seam can fetch from today. */
export const SUPPORTED_SOURCE_PROVIDERS = ['google'] as const;

/**
 * Resolve a knowledge source to `{ title, text }`. Throws an `OpenwopError`
 * (mapped to a stable HTTP code) on any failure — never returns empty silently.
 */
export async function fetchKnowledgeSource(
  deps: KnowledgeFetchDeps,
  input: { provider: string; ref: string },
): Promise<FetchedSource> {
  const provider = String(input.provider ?? '').trim().toLowerCase();
  const ref = String(input.ref ?? '').trim();
  if (!ref) {
    throw new OpenwopError('validation_error', 'Field `ref` is required (a Drive link or file id).', 400, { field: 'ref' });
  }
  if (provider === 'google') return fetchGoogleDriveDoc(deps, ref);
  throw new OpenwopError(
    'validation_error',
    `Unsupported knowledge-source provider '${input.provider}'. Supported: ${SUPPORTED_SOURCE_PROVIDERS.join(', ')}.`,
    400,
    { provider: input.provider, supported: SUPPORTED_SOURCE_PROVIDERS },
  );
}

// ── Google Drive ────────────────────────────────────────────────────────────

/** Extract a Drive file id from a raw id or any common Drive/Docs URL form.
 *  Returns null when no id can be recovered (caller maps to a 400). Pure. */
export function extractDriveFileId(ref: string): string | null {
  const s = ref.trim();
  // Raw id: Drive ids are URL-safe base64-ish, typically 25+ chars, no spaces.
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  // .../d/<id>/...  (docs.google.com/document/d/<id>, drive.google.com/file/d/<id>)
  const dPath = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (dPath) return dPath[1];
  // ...?id=<id> or &id=<id>  (drive.google.com/open?id=<id>, uc?id=<id>)
  const idParam = /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  if (idParam) return idParam[1];
  return null;
}

/** Map a Drive file's mimeType to the read URL + how to read it. Google-native
 *  docs export to text; plain-text files read via alt=media; anything else is
 *  rejected (we only ingest extractable text). Pure. */
export function driveReadPlan(fileId: string, mimeType: string): { url: string } | { unsupported: string } {
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const common = 'supportsAllDrives=true';
  if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.presentation') {
    return { url: `${base}/export?mimeType=text%2Fplain&${common}` };
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return { url: `${base}/export?mimeType=text%2Fcsv&${common}` };
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return { url: `${base}?alt=media&${common}` };
  }
  return { unsupported: mimeType };
}

async function fetchGoogleDriveDoc(deps: KnowledgeFetchDeps, ref: string): Promise<FetchedSource> {
  const fileId = extractDriveFileId(ref);
  if (!fileId) {
    throw new OpenwopError('validation_error', 'Could not find a Google Drive file id in `ref`.', 400, { ref });
  }
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };

  // 1) Metadata → name + mimeType (also the cheapest probe of access/connection).
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name%2CmimeType&supportsAllDrives=true`;
  const meta = await brokeredFetch(egressDeps, { provider: 'google', url: metaUrl });
  failClosed(meta, 'google');
  const metaJson = (await readJson(meta)) as { name?: unknown; mimeType?: unknown } | undefined;
  const name = typeof metaJson?.name === 'string' && metaJson.name.trim() ? metaJson.name.trim() : 'Drive document';
  const mimeType = typeof metaJson?.mimeType === 'string' ? metaJson.mimeType : '';

  const plan = driveReadPlan(fileId, mimeType);
  if ('unsupported' in plan) {
    throw new OpenwopError(
      'validation_error',
      `Google Drive file type '${plan.unsupported}' has no extractable text. Use a Doc, Sheet, Slides, or a text file.`,
      400,
      { fileId, mimeType: plan.unsupported },
    );
  }

  // 2) Content.
  const content = await brokeredFetch(egressDeps, { provider: 'google', url: plan.url });
  failClosed(content, 'google');
  const text = await readText(content);
  if (!text.trim()) {
    throw new OpenwopError('validation_error', 'The Google Drive file has no readable text content.', 400, { fileId });
  }
  return { title: name, text, sourceUrl: plan.url };
}

// ── shared outcome → error mapping + bounded readers ─────────────────────────

type Sent = Extract<Awaited<ReturnType<typeof brokeredFetch>>, { outcome: 'sent' }>;

/** Throw a stable, actionable OpenwopError for every non-success outcome, and for
 *  a transport-success that the provider rejected (404/403/…). Narrows to `Sent`. */
function failClosed(r: Awaited<ReturnType<typeof brokeredFetch>>, provider: string): asserts r is Sent {
  if (r.outcome === 'no_connection') {
    throw new OpenwopError('credential_required', `Connect your ${providerLabel(provider)} account first, then import.`, 409, { provider });
  }
  if (r.outcome === 'host_not_allowed') {
    throw new OpenwopError('validation_error', 'Resolved source URL is not an allowed provider API host.', 400, { provider, host: r.host });
  }
  if (r.outcome === 'insecure_base') {
    throw new OpenwopError('validation_error', 'Source URL must be https.', 400, { provider });
  }
  if (r.outcome === 'request_failed') {
    throw new OpenwopError('internal_error', `Could not reach ${providerLabel(provider)} (${r.timedOut ? 'timed out' : 'request failed'}).`, 502, { provider });
  }
  // transport reached the provider — surface its HTTP error meaningfully
  if (!r.res.ok) {
    if (r.res.status === 404) throw new OpenwopError('not_found', 'Source not found, or it is not shared with your connected account.', 404, { provider });
    if (r.res.status === 403 || r.res.status === 401) {
      throw new OpenwopError('forbidden', 'Your connected account cannot access this source (check sharing / scopes).', 403, { provider });
    }
    throw new OpenwopError('internal_error', `${providerLabel(provider)} returned HTTP ${r.res.status}.`, 502, { provider, status: r.res.status });
  }
}

function providerLabel(provider: string): string {
  return provider === 'google' ? 'Google' : provider;
}

async function readText(r: Sent): Promise<string> {
  const body = await r.res.text();
  return body.length > MAX_FETCH_BYTES ? body.slice(0, MAX_FETCH_BYTES) : body;
}

async function readJson(r: Sent): Promise<unknown> {
  try {
    return JSON.parse(await readText(r));
  } catch {
    return undefined;
  }
}
