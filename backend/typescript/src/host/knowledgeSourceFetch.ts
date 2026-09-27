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
import { fetch as undiciFetch } from 'undici';
import {
  assertEgressSchemeAllowed,
  EgressUrlRejectedError,
  isDeniedWebhookHost,
  webhookEgressDispatcher,
  webhookPrivateEgressAllowed,
} from './webhookEgressGuard.js';
import { assertEgressAllowed } from './egressPolicy.js';

/** A fetched source ready for `kbService.ingestDocument({ title, text })`. */
export interface FetchedSource {
  title: string;
  text: string;
  /** The provider-API URL the text was read from (for the document's audit trail). */
  sourceUrl: string;
}

/** Raw bytes of a connected-drive file + its MIME — for binary (PDF/Office) ingest,
 *  where `kbService.extractTextFromBytes` does the tokenization. */
export interface FetchedBytes {
  title: string;
  contentBase64: string;
  contentType: string;
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
export const SUPPORTED_SOURCE_PROVIDERS = ['google', 'microsoft-graph', 'microsoft-sharepoint', 'dropbox', 'box'] as const;

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
  if (provider === 'microsoft-graph' || provider === 'microsoft-sharepoint') return fetchOneDriveItem(deps, provider, ref);
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

/** Normalize a Google Drive FOLDER reference (ADR 0107) — accepts a pasted folder
 *  URL (`drive.google.com/drive/folders/<id>`, `/drive/u/0/folders/<id>?usp=…`) OR a
 *  bare id, and returns the bare folder id. Distinct from `extractDriveFileId`: a
 *  folder URL has neither `/d/<id>/` nor `?id=`. The raw-id branch uses the SAME
 *  charset as the `DRIVE_ID_RE` list-time guard (not `{20,}`), so create-time
 *  normalization and list-time validation agree. Returns null when no id can be
 *  recovered (caller maps to a 400 — never persist an unparseable folder ref). Pure. */
export function extractDriveFolderId(ref: string): string | null {
  const s = ref.trim();
  // .../folders/<id>  (the Drive folder URL shape, incl. /drive/u/<n>/folders/<id>)
  const folderPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(s);
  if (folderPath) return folderPath[1];
  // A bare id — accept exactly what the list-time guard accepts (DRIVE_ID_RE).
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
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

/**
 * Download a connected-drive file as RAW BYTES + its contentType — for binary
 * (PDF/Office) sync ingest, where `kbService.extractTextFromBytes` does the
 * tokenization. NOT for Google-native docs (Docs/Sheets/Slides have no media bytes —
 * the caller routes those to `fetchKnowledgeSource` for text export). SSRF-guarded
 * via `brokeredFetch` (no-redirect): Google `?alt=media` returns the bytes directly
 * from `googleapis.com`.
 *
 * ADR 0605 Tier 7 (`KSC-13`) — this used to say *"OneDrive byte download is a
 * follow-on … it would need the `@microsoft.graph.downloadUrl` + a
 * Microsoft-download-host SSRF guard"*, 53 lines above `fetchOneDriveBytes`, which
 * does exactly that and has since 2026-06-23. The reason this survived is worth
 * naming: the sentence described the correct DESIGN, so it reads as current even
 * once it is describing the implementation instead of the plan. All five providers
 * ship byte download — see the provider dispatch in the body below.
 */
export async function fetchKnowledgeSourceBytes(deps: KnowledgeFetchDeps, input: { provider: string; ref: string; mimeType?: string }): Promise<FetchedBytes> {
  const provider = String(input.provider ?? '').trim().toLowerCase();
  const ref = String(input.ref ?? '').trim();
  if (!ref) throw new OpenwopError('validation_error', 'Field `ref` is required.', 400, { field: 'ref' });
  // Audio gets the larger download cap (ADR 0111 follow-on) so long synced recordings reach
  // the File-API transcription path, matching manual upload.
  const maxBytes = /^audio\//i.test(String(input.mimeType ?? '')) ? MAX_AUDIO_FETCH_BYTES : MAX_BINARY_FETCH_BYTES;
  if (provider === 'google') return fetchGoogleDriveBytes(deps, ref, maxBytes);
  if (provider === 'microsoft-graph' || provider === 'microsoft-sharepoint') return fetchOneDriveBytes(deps, provider, ref, maxBytes);
  if (provider === 'dropbox') return fetchDropboxBytes(deps, ref, maxBytes);
  if (provider === 'box') return fetchBoxBytes(deps, ref, maxBytes);
  throw new OpenwopError('validation_error', `Binary download is not supported for provider '${input.provider}'.`, 400, { provider });
}

async function fetchGoogleDriveBytes(deps: KnowledgeFetchDeps, ref: string, maxBytes: number): Promise<FetchedBytes> {
  const fileId = extractDriveFileId(ref);
  if (!fileId) throw new OpenwopError('validation_error', 'Could not find a Google Drive file id in `ref`.', 400, { ref });
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  // 1) meta → name + mimeType (the file's true type drives extraction).
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name%2CmimeType&supportsAllDrives=true`;
  const meta = await brokeredFetch(egressDeps, { provider: 'google', url: metaUrl });
  failClosed(meta, 'google');
  const metaJson = (await readJson(meta)) as { name?: unknown; mimeType?: unknown } | undefined;
  const name = typeof metaJson?.name === 'string' && metaJson.name.trim() ? metaJson.name.trim() : 'Drive file';
  const contentType = typeof metaJson?.mimeType === 'string' ? metaJson.mimeType : 'application/octet-stream';
  // 2) bytes — `alt=media` streams the file directly (200, same host, no redirect).
  const contentUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const content = await brokeredFetch(egressDeps, { provider: 'google', url: contentUrl });
  failClosed(content, 'google');
  const bytes = await readBytes(content.res, maxBytes);
  return { title: name, contentBase64: bytes.toString('base64'), contentType, sourceUrl: contentUrl };
}

/**
 * Download a OneDrive / SharePoint file as bytes via Microsoft Graph. Graph `/content`
 * 302s to a separate download host the no-follow-redirect credential broker can't chase,
 * so instead we read the item's `@microsoft.graph.downloadUrl` — a SHORT-LIVED,
 * PRE-AUTHENTICATED URL (no token) — and fetch THAT through the host's SSRF egress guard
 * (`webhookEgressGuard`: private-IP block + a pinned dispatcher that re-validates each
 * redirect hop's resolved address). No credential rides the download (so there's no
 * token-leak-on-redirect risk), ~~https-only~~, 32MB cap.
 *
 * ADR 0605 Tier 7 (`KSC-8`) — "https-only" was IMPRECISE, and imprecise in the
 * direction that flatters the code. Stated exactly: `fetchGuardedBytes` checks
 * `url.protocol !== 'https:'` on the URL IT IS GIVEN — redirect hop 1 — and then
 * hands the request to `undiciFetch` with `redirect` unset, i.e. the fetch default
 * `'follow'`, up to 20 hops. What the pinned dispatcher re-validates PER HOP is the
 * resolved ADDRESS (the private-range guard), not the scheme and not the host
 * denylist. So a `302` from a provider download host to `http://` is followed, and
 * the un-credentialed body then arrives over cleartext, attacker-modifiable in
 * transit, on its way into the customer's knowledge base. Note the sibling
 * `guardedEgressFetch` in the same guard module defaults to `redirect:'error'`
 * precisely to close this; this call site hand-rolled a weaker subset of it and so
 * does not inherit the default.
 *
 * NOT FIXED HERE, deliberately: adding a per-hop scheme check (or routing through
 * `guardedEgressFetch` with a manual redirect loop) changes what this function
 * accepts from a live provider, which is a behaviour change and needs its own
 * witness against a real redirect chain — a records tier must not smuggle one in.
 * Filed OPEN as `KSC-8`, which also carries this call site's missing timeout,
 * missing `maxResponseSize`, and skipped ADR 0187 tenant egress firewall.
 */
async function fetchOneDriveBytes(deps: KnowledgeFetchDeps, syncProvider: string, ref: string, maxBytes: number): Promise<FetchedBytes> {
  const base = graphItemsBase(syncProvider, ref); // validates the Graph item id
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  // 1) item metadata (credentialed, graph.microsoft.com) — NO $select: the
  //    `@microsoft.graph.downloadUrl` is an instance annotation that $select can drop.
  const meta = await brokeredFetch(egressDeps, { provider: 'microsoft-graph', url: base });
  failClosed(meta, 'microsoft-graph');
  const item = (await readJson(meta)) as { name?: unknown; file?: { mimeType?: unknown }; ['@microsoft.graph.downloadUrl']?: unknown } | undefined;
  const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : 'OneDrive file';
  const contentType = typeof item?.file?.mimeType === 'string' ? item.file.mimeType : 'application/octet-stream';
  const downloadUrl = item?.['@microsoft.graph.downloadUrl'];
  if (typeof downloadUrl !== 'string' || !downloadUrl) {
    throw new OpenwopError('validation_error', 'OneDrive item has no download URL (a folder, or access was denied).', 422, { ref });
  }
  // 2) fetch the pre-authenticated URL UN-credentialed, SSRF-guarded.
  const bytes = await fetchGuardedBytes(downloadUrl, 'OneDrive', maxBytes, { tenantId: deps.tenantId });
  return { title: name, contentBase64: bytes.toString('base64'), contentType, sourceUrl: `${base}/content` };
}

/** Fetch a PRE-AUTHENTICATED download URL (no credential) through the host SSRF egress
 *  guard, 32MB cap. Shared by every "temp/pre-auth download URL" provider
 *  (OneDrive/SharePoint `@microsoft.graph.downloadUrl`, Dropbox `get_temporary_link`).
 *
 *  ADR 0605 Tier 7 (`KSC-8`) — this used to read "https-only, private-IP-blocked,
 *  the pinned dispatcher re-validates each redirect hop", which reads as three
 *  per-hop guarantees and is one. Precisely, per hop:
 *    - resolved address vs the private ranges — YES, every hop (`guardedLookup` runs
 *      at connect time for each new socket, so a DNS rebind is refused at dial).
 *    - scheme is https — NO. Checked once, below, on the URL passed in. `undiciFetch`
 *      is called with no `redirect`, so the default `'follow'` applies and a hop to
 *      `http://` is taken.
 *    - `isDeniedWebhookHost` string precheck — NO, also once, below. In practice a
 *      denied host resolves into a private range and the lookup catches it anyway,
 *      which is why this half has never mattered; the SCHEME half has. */
export async function fetchGuardedBytes(
  downloadUrl: string,
  label: string,
  maxBytes = MAX_BINARY_FETCH_BYTES,
  opts: { tenantId?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  let current = downloadUrl;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_DOWNLOAD_REDIRECTS) {
      throw new OpenwopError(
        'validation_error',
        `${label} download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects.`,
        502,
        { hops: hop },
      );
    }
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new OpenwopError('validation_error', `Malformed ${label} download URL.`, 502, {});
    }

    // ADR 0609 / KSC-8 — the SCHEME arm, now per hop, via the ADR 0607 shared
    // predicate rather than a hand-rolled copy. `honorDevFlag: true` matches the
    // rest of this file's egress posture (and makes a loopback redirect chain
    // testable); in production the flag is off and every hop must be https.
    try {
      assertEgressSchemeAllowed(current, { honorDevFlag: true });
    } catch (e) {
      if (!(e instanceof EgressUrlRejectedError)) throw e;
      throw new OpenwopError(
        'validation_error',
        hop === 0
          ? `${label} download URL must be https.`
          : `${label} download redirected to a non-https URL (hop ${hop}) — refused.`,
        502,
        { reason: e.reason, hop },
      );
    }

    // The denied-host string precheck, also per hop. The pinned-resolution
    // lookup already refuses a private ADDRESS at dial on every hop; this is the
    // cheap literal check in front of it, and it was previously hop-1 only.
    if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) {
      throw new OpenwopError('validation_error', `${label} download host is not permitted.`, 502, {
        host: url.hostname,
        hop,
      });
    }

    // ADR 0187 tenant egress firewall — this call site skipped it entirely, so a
    // tenant policy that blocks a host was not enforced on the download leg even
    // though the credentialed metadata leg (`brokeredFetch`) honours it. Applied
    // per hop, because a redirect target is a different host than the one the
    // policy was evaluated against.
    if (opts.tenantId) await assertEgressAllowed(opts.tenantId, current);

    const res = await undiciFetch(current, {
      // `redirect: 'manual'` is what makes the arms above per-hop. The default
      // 'follow' hands the whole chain to undici, where nothing re-checks the
      // scheme, the host literal, or the tenant policy.
      redirect: 'manual',
      dispatcher: webhookEgressDispatcher(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new OpenwopError('internal_error', `${label} download redirect had no location.`, 502, {
          status: res.status,
          hop,
        });
      }
      current = new URL(location, url).toString();
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new OpenwopError('internal_error', `${label} download failed (HTTP ${res.status}).`, 502, {
        status: res.status,
      });
    }
    return await readBytesStreamed(res, maxBytes, label);
  }
}

/**
 * Read a response body with the cap applied DURING the read.
 *
 * KSC-8: `readBytes` does `Buffer.from(await res.arrayBuffer())` and checks the
 * length afterwards — so a body larger than the cap is fully materialised in
 * memory BEFORE being rejected. On a memory-bounded Cloud Run instance a
 * multi-GB response from a redirect target OOM-kills the container, and the
 * 32 MiB "cap" never runs. Streaming makes the cap a bound on what is read
 * rather than a verdict on what was already read.
 */
async function readBytesStreamed(
  res: { body?: unknown; arrayBuffer?: () => Promise<ArrayBuffer> },
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const tooBig = (): never => {
    throw new OpenwopError(
      'validation_error',
      `${label} file exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB sync cap.`,
      413,
      { maxBytes },
    );
  };

  const body = res.body as AsyncIterable<Uint8Array> | null | undefined;
  const streamable =
    body != null && typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';

  if (streamable) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) tooBig();
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  // A response that exposes no async-iterable body — a zero-length 200, or a
  // caller-supplied stub. Fall back to the buffered read rather than returning
  // an EMPTY buffer: `Buffer.alloc(0)` here would be a success-with-empty, and
  // on this path an empty document is silently ingested as the file's contents.
  // That is the exact failure ADR 0605 Tier 1 removed from `readJson`, where
  // "returned nothing" became an empty folder listing and then a mass delete.
  //
  // The memory bound therefore holds on the STREAMING path, which is the one
  // real undici responses take — witnessed by the sabotage in
  // `ksc8-download-redirect-guard.test.ts`, which drives a real socket and goes
  // red when the streaming reader is swapped for the buffered one.
  if (typeof res.arrayBuffer !== 'function') {
    throw new OpenwopError('internal_error', `${label} download returned no readable body.`, 502, {});
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) tooBig();
  return buf;
}

// ── Dropbox ──────────────────────────────────────────────────────────────────

/** Infer a MIME from a file-name extension — Dropbox metadata omits the content type,
 *  so the diff + extractor get it from the name. Unknown ⇒ octet-stream (extractor 415s). */
const DROPBOX_EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
};
function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return DROPBOX_EXT_MIME[ext] ?? 'application/octet-stream';
}

async function listDropboxFolder(deps: KnowledgeFetchDeps, folderId: string): Promise<SyncFolderListing> {
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  // The ref rides the JSON BODY (not the URL) → no URL-injection surface. `root` ⇒ ''.
  const ref = folderId.trim();
  if (!ref) throw new OpenwopError('validation_error', 'A Dropbox folder path or id is required.', 400, {});
  let url = 'https://api.dropboxapi.com/2/files/list_folder';
  let body = JSON.stringify({ path: ref === 'root' ? '' : ref, recursive: false, limit: 200 });
  const out: SyncFolderFile[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const r = await brokeredFetch(egressDeps, { provider: 'dropbox', url, method: 'POST', body });
    failClosed(r, 'dropbox');
    const json = (await readJson(r)) as { entries?: unknown; cursor?: unknown; has_more?: unknown } | undefined;
    // ADR 0605 R1 — a `2xx` with no `entries` array is not an empty folder.
    const entries = listingArray(json, 'entries', 'Dropbox');
    for (const e of entries) {
      const rec = e as Record<string, unknown>;
      if (rec['.tag'] !== 'file') continue; // files only (skip folders — no recursion)
      const id = typeof rec.id === 'string' ? rec.id : '';
      const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled';
      if (!id) continue;
      out.push({ fileId: id, name, mimeType: mimeFromName(name), revision: typeof rec.rev === 'string' ? rec.rev : (typeof rec.content_hash === 'string' ? rec.content_hash : '') });
      if (out.length >= MAX_LIST_FILES) return partialListing(out, 'file_cap');
    }
    if (json?.has_more !== true) return completeListing(out); // drained
    // `has_more` says there ARE more entries; without a usable cursor we cannot
    // reach them, so the listing is short — never "the folder ends here".
    if (typeof json.cursor !== 'string' || !json.cursor) return partialListing(out, 'bad_page_token');
    url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
    body = JSON.stringify({ cursor: json.cursor });
  }
  return partialListing(out, 'page_budget');
}

async function fetchDropboxBytes(deps: KnowledgeFetchDeps, ref: string, maxBytes: number): Promise<FetchedBytes> {
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  // get_temporary_link returns a short-lived direct-download URL (on *.dropboxusercontent.com).
  const linkRes = await brokeredFetch(egressDeps, { provider: 'dropbox', url: 'https://api.dropboxapi.com/2/files/get_temporary_link', method: 'POST', body: JSON.stringify({ path: ref }) });
  failClosed(linkRes, 'dropbox');
  const json = (await readJson(linkRes)) as { link?: unknown; metadata?: { name?: unknown } } | undefined;
  const link = json?.link;
  const name = typeof json?.metadata?.name === 'string' && json.metadata.name.trim() ? json.metadata.name.trim() : 'Dropbox file';
  if (typeof link !== 'string' || !link) throw new OpenwopError('validation_error', 'Dropbox returned no download link.', 422, { ref });
  const bytes = await fetchGuardedBytes(link, 'Dropbox', maxBytes, { tenantId: deps.tenantId });
  return { title: name, contentBase64: bytes.toString('base64'), contentType: mimeFromName(name), sourceUrl: link };
}

// ── Box ────────────────────────────────────────────────────────────────────

/** Box folder/file ids are numeric/alphanumeric — validate so an id can't traverse
 *  the REST path (`/2.0/folders/{id}/items`). */
const BOX_ID_RE = /^[A-Za-z0-9]+$/;
function safeBoxId(id: string, label: string): string {
  const t = id.trim();
  if (!t || !BOX_ID_RE.test(t)) throw new OpenwopError('validation_error', `Invalid Box ${label} id.`, 400, { id });
  return t;
}

async function listBoxFolder(deps: KnowledgeFetchDeps, folderId: string): Promise<SyncFolderListing> {
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  const id = folderId.trim() === 'root' ? '0' : safeBoxId(folderId, 'folder'); // '0' is the Box root
  const out: SyncFolderFile[] = [];
  const limit = 1000;
  let offset = 0;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url = `https://api.box.com/2.0/folders/${id}/items?fields=id%2Cname%2Ctype%2Cetag%2Cmodified_at&limit=${limit}&offset=${offset}`;
    const r = await brokeredFetch(egressDeps, { provider: 'box', url });
    failClosed(r, 'box');
    const json = (await readJson(r)) as { entries?: unknown; total_count?: unknown } | undefined;
    // ADR 0605 R1 — a `2xx` with no `entries` array is not an empty folder.
    const entries = listingArray(json, 'entries', 'Box');
    for (const e of entries) {
      const rec = e as Record<string, unknown>;
      if (rec.type !== 'file') continue; // files only (skip folders — no recursion)
      const fid = typeof rec.id === 'string' ? rec.id : '';
      if (!fid) continue;
      const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled';
      out.push({ fileId: fid, name, mimeType: mimeFromName(name), revision: typeof rec.etag === 'string' ? rec.etag : (typeof rec.modified_at === 'string' ? rec.modified_at : '') });
      if (out.length >= MAX_LIST_FILES) return partialListing(out, 'file_cap');
    }
    offset += limit;
    if (boxDrained(entries.length, limit, offset, json?.total_count)) return completeListing(out);
  }
  return partialListing(out, 'page_budget');
}

/**
 * Has the Box `/items` cursor reached the end of the folder? PURE, so the rule
 * is testable on its own rather than inferred from a listing.
 *
 * ADR 0605 R1 (review MEDIUM 5) — this used to be
 * `const total = typeof total_count === 'number' ? total_count : entries.length`
 * followed by `offset >= total`. The FALLBACK is the defect: substituting the
 * page size for the folder size makes `offset >= total` trivially true on ANY
 * full page, so one full page of 1000 entries with no `total_count` reported
 * `complete: true` over a folder that may hold ten thousand. Pre-Tier-1 that was
 * a silent `break`; Tier 1 turned the same unknown into an AFFIRMATIVE claim of
 * completeness, which `diffFolderListing` then acts on by deleting — strictly
 * worse than the bug it replaced.
 *
 * The drain signal Box actually gives is a SHORT PAGE, and it was available and
 * unused. `total_count` is now consulted ONLY when Box sent one; when it did
 * not, an unknown stays unknown and the loop asks for another page (running out
 * of pages yields `page_budget`, i.e. `complete: false`).
 */
export function boxDrained(pageEntries: number, limit: number, nextOffset: number, totalCount: unknown): boolean {
  if (pageEntries === 0) return true;          // the page was empty — nothing after it
  if (pageEntries < limit) return true;        // a short page IS the end of the folder
  return typeof totalCount === 'number' && nextOffset >= totalCount;
}

async function fetchBoxBytes(deps: KnowledgeFetchDeps, ref: string, maxBytes: number): Promise<FetchedBytes> {
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  const id = safeBoxId(ref, 'file');
  // 1) meta → name (title + MIME inference; Box gives no content type otherwise).
  const meta = await brokeredFetch(egressDeps, { provider: 'box', url: `https://api.box.com/2.0/files/${id}?fields=name` });
  failClosed(meta, 'box');
  const metaJson = (await readJson(meta)) as { name?: unknown } | undefined;
  const name = typeof metaJson?.name === 'string' && metaJson.name.trim() ? metaJson.name.trim() : 'Box file';
  // 2) content → a 302 to dl.boxcloud.com. redirect:'manual' RETURNS the 302 (the token
  //    stays on api.box.com, never sent to the download host); read the Location and
  //    fetch it un-credentialed + SSRF-guarded.
  const dl = await brokeredFetch(egressDeps, { provider: 'box', url: `https://api.box.com/2.0/files/${id}/content`, redirect: 'manual' });
  if (dl.outcome === 'no_connection') throw new OpenwopError('credential_required', 'Connect your Box account first.', 409, { provider: 'box' });
  if (dl.outcome === 'host_not_allowed') throw new OpenwopError('validation_error', 'Resolved Box URL is not an allowed host.', 400, {});
  if (dl.outcome === 'insecure_base') throw new OpenwopError('validation_error', 'Box URL must be https.', 400, {});
  if (dl.outcome === 'request_failed') throw new OpenwopError('internal_error', 'Could not reach Box.', 502, { provider: 'box' });
  const location = dl.res.headers.get('location');
  if (!location) throw new OpenwopError('internal_error', `Box content did not return a download location (HTTP ${dl.res.status}).`, 502, { ref });
  const bytes = await fetchGuardedBytes(location, 'Box', maxBytes, { tenantId: deps.tenantId });
  return { title: name, contentBase64: bytes.toString('base64'), contentType: mimeFromName(name), sourceUrl: location };
}

// ── folder listing (ADR 0107 Phase 1 — knowledge-sync source diff) ───────────

export interface SyncFolderFile {
  fileId: string;
  name: string;
  mimeType: string;
  /** The provider change-cursor (Drive `modifiedTime`) — ADR 0107's diff revision:
   *  a changed value means the file was edited since the last sync. */
  revision: string;
}

/** Hard caps so a huge folder can't run unbounded (ADR 0107 OQ-3). v1 reads up to
 *  these per call; incremental cross-run pagination is a later optimization. */
/** EXPORTED because it is USER-FACING: when the cap truncates a listing the
 *  runner tells the user "this folder has more than N files". That sentence must
 *  be GENERATED from the cap, never hand-copied beside it — a copied number is
 *  the drift class CLAUDE.md § "AI↔app information exchange" names, and it reads
 *  as authoritative long after the cap moves. */
export const MAX_LIST_FILES = 1000;
const MAX_LIST_PAGES = 20;

/** Why a listing could not be proved COMPLETE (ADR 0605). Each value is a real
 *  early exit in the loops below, not a hypothetical. */
export type ListingIncompleteReason =
  /** `MAX_LIST_FILES` truncated the listing mid-folder. */
  | 'file_cap'
  /** `MAX_LIST_PAGES` ran out while the provider still had pages to give. */
  | 'page_budget'
  /** The provider advertised more pages but its continuation token was unusable. */
  | 'bad_page_token';

/**
 * A folder listing PLUS whether it is the WHOLE folder (ADR 0605 Tier 1 —
 * `KSC-1`/`KSC-3`/`KSC-5`/`KSWF-3`).
 *
 * The destructive half of a diff-sync — "a prior state exists but the file is
 * gone from the folder, so delete its KB document" — is only sound if the
 * listing is known to be the complete folder. Before this type, `listFolder`
 * returned a bare array and there was NO WAY for the caller to distinguish
 * "the folder is empty" from "I could not see all of it": the `MAX_LIST_FILES`
 * cap truncated silently (measured: 1200 known files → 200 live KB documents
 * deleted), a broken page-token chain broke the loop silently, and an
 * unparseable body degraded to `[]` (now a throw — see `readJson`).
 *
 * `complete` is a CLAIM the lister must earn. Consumers MUST fail closed on
 * anything that is not literally `true` — see `diffFolderListing`, which is the
 * one composition owner that enforces it.
 */
export interface SyncFolderListing {
  files: SyncFolderFile[];
  /** True ONLY when the loop drained the folder. Never assume; see above. */
  complete: boolean;
  incompleteReason?: ListingIncompleteReason;
}

/** The body as a plain JSON OBJECT, or undefined. An array, a string, a number
 *  and `null` are all things a proxy or an error page can produce, and none of
 *  them is a folder listing. */
function plainObject(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/**
 * The array a folder LISTING must have carried, or a typed 502.
 *
 * ADR 0605 R1 (review HIGH 2) — **the cure's own family, one layer up.** Tier 1
 * made `readJson` throw on an unparseable `2xx`; one line later every lister did
 * `Array.isArray(body?.files) ? body.files : []` and then declared the folder
 * DRAINED. So the exact substitution Tier 1 exists to eliminate — *the layer
 * returned `[]` for two different facts* — survived intact one layer up, for
 * every provider. MEASURED by the review: `{}` and
 * `{"error":{"code":403,"message":"insufficient scope"}}` each produced
 * `{ files: [], complete: true }`, and `diffFolderListing` then prunes every
 * known file, because the listing SAYS it is the whole folder.
 *
 * ADR 0605's own motivating scenarios land HERE, not in `readJson`: an
 * interposing proxy answering `200 {"status":"ok"}`, a captive portal, an OAuth
 * interstitial. All are valid JSON, so `readJson` passes them through.
 *
 * ONE helper for every lister rather than four hand-written copies — a fix for
 * one lister is not a fix for the class, and the copies are what drift.
 */
function listingArray(body: unknown, field: string, provider: string): unknown[] {
  const v = plainObject(body)?.[field];
  if (Array.isArray(v)) return v;
  throw new OpenwopError(
    'internal_error',
    `The ${provider} folder listing returned a success status with no \`${field}\` array. Refusing to treat it as an empty folder.`,
    502,
    { provider, field },
  );
}

/** The `kind` every Drive `files.list` response carries. Requested explicitly in
 *  the `fields` mask below — see `driveListingFiles`. */
const DRIVE_FILE_LIST_KIND = 'drive#fileList';

/**
 * Google Drive is the ONE provider where "no `files` key" can be a legitimate
 * empty result, so it does not use `listingArray`.
 *
 * A Drive partial response (`fields=…`) OMITS a field whose value is empty, so
 * an empty folder can come back as `{"kind":"drive#fileList"}` with no `files`
 * at all. Requiring the array unconditionally would have turned the CORRECT
 * empty-folder prune — the product guarantee `knowledge-sync.test.ts:46-51`
 * pins and ADR 0605 § "Why the fetch boundary" defends — into a permanent 502,
 * i.e. traded a data-loss bug for a sync that never converges.
 *
 * So discriminate on `kind`, which the mask now requests and which is never a
 * default/empty value: a body that IS a Drive file list may omit `files`; a body
 * that is not one (`{}`, a proxy's `{"status":"ok"}`, an `{"error":…}` envelope)
 * is refused. **This is correct under either reading of the Drive contract** — if
 * Drive in fact always sends `files: []`, the `kind` branch simply never fires,
 * and the first branch below has already accepted the response. The design does
 * not depend on resolving that uncertainty, which is why it was chosen over
 * "treat a missing array as incomplete" (that one is wrong in exactly one of the
 * two worlds, and silently).
 */
function driveListingFiles(body: unknown): unknown[] {
  const rec = plainObject(body);
  const v = rec?.files;
  if (Array.isArray(v)) return v;
  if (v === undefined && rec?.kind === DRIVE_FILE_LIST_KIND) return [];
  throw new OpenwopError(
    'internal_error',
    'The Google Drive folder listing returned a success status with no file list. Refusing to treat it as an empty folder.',
    502,
    { provider: 'google' },
  );
}

/** A listing the lister drained to the end. */
function completeListing(files: SyncFolderFile[]): SyncFolderListing {
  return { files, complete: true };
}

/** A listing that stopped early — the caller must not prune from it. */
function partialListing(files: SyncFolderFile[], incompleteReason: ListingIncompleteReason): SyncFolderListing {
  return { files, complete: false, incompleteReason };
}

/** List the non-trashed files DIRECTLY under a connected drive folder, via the
 *  SSRF-guarded Connections broker (no token handling here — same egress path as
 *  `fetchKnowledgeSource`). Top-level only (no recursion — ADR 0107 OQ-2 default).
 *  All five wired providers list here (Google Drive, OneDrive, SharePoint,
 *  Dropbox, Box). The result feeds the knowledge-sync diff (NEW/CHANGED/DELETED).
 *
 *  Returns a `SyncFolderListing`, NOT a bare array: the caller needs to know
 *  whether the listing is the whole folder before it may treat an absent file as
 *  a deleted one (ADR 0605). */
export async function listFolder(deps: KnowledgeFetchDeps, provider: string, folderId: string): Promise<SyncFolderListing> {
  if (provider === 'google') return listGoogleDriveFolder(deps, folderId);
  if (provider === 'microsoft-graph' || provider === 'microsoft-sharepoint') return listOneDriveFolder(deps, provider, folderId);
  if (provider === 'dropbox') return listDropboxFolder(deps, folderId);
  if (provider === 'box') return listBoxFolder(deps, folderId);
  throw new OpenwopError('validation_error', `Folder listing is not supported for provider '${provider}'.`, 400, { provider });
}

/** A subfolder for the folder picker — its provider id (to drill into) + display name. */
export interface BrowseFolder { id: string; name: string }

/**
 * List the SUBFOLDERS directly under `folderId` (read-only) — the inverse of
 * `listFolder`'s files-only listing, for the folder picker. Same SSRF-guarded broker
 * + per-provider id guards. Kept SEPARATE from `listFolder` so the critical sync path
 * is untouched. SharePoint browsing (sites→libraries) is not yet wired (raw-id entry).
 */
export async function browseFolders(deps: KnowledgeFetchDeps, provider: string, folderId: string): Promise<BrowseFolder[]> {
  const egressDeps = {
    storage: deps.storage, tenantId: deps.tenantId, runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId, ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  const pushName = (out: BrowseFolder[], id: string, rawName: unknown): void => {
    if (id) out.push({ id, name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'Untitled' });
  };

  if (provider === 'google') {
    const id = folderId.trim() || 'root';
    if (id !== 'root' && (!DRIVE_ID_RE.test(id) || id.includes('..'))) throw new OpenwopError('validation_error', 'Invalid Drive folder id.', 400, { folderId });
    const q = encodeURIComponent(`'${id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`);
    const fields = encodeURIComponent('nextPageToken,files(id,name)');
    const out: BrowseFolder[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const r = await brokeredFetch(egressDeps, { provider: 'google', url });
      failClosed(r, 'google');
      const body = (await readJson(r)) as { files?: unknown; nextPageToken?: unknown } | undefined;
      for (const f of Array.isArray(body?.files) ? body.files : []) { const rec = f as Record<string, unknown>; pushName(out, typeof rec.id === 'string' ? rec.id : '', rec.name); if (out.length >= MAX_LIST_FILES) return out; }
      pageToken = typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  if (provider === 'microsoft-graph') {
    let url: string | undefined = `${graphItemsBase('microsoft-graph', folderId.trim() || 'root')}/children?$select=${encodeURIComponent('id,name,folder')}&$top=200`;
    const out: BrowseFolder[] = [];
    for (let page = 0; page < MAX_LIST_PAGES && url; page += 1) {
      const r = await brokeredFetch(egressDeps, { provider: 'microsoft-graph', url });
      failClosed(r, 'microsoft-graph');
      const body = (await readJson(r)) as { value?: unknown; ['@odata.nextLink']?: unknown } | undefined;
      for (const it of Array.isArray(body?.value) ? body.value : []) { const rec = it as Record<string, unknown>; if (!rec.folder) continue; pushName(out, typeof rec.id === 'string' ? rec.id : '', rec.name); if (out.length >= MAX_LIST_FILES) return out; }
      const next = body?.['@odata.nextLink'];
      url = typeof next === 'string' && next.startsWith('https://graph.microsoft.com/') ? next : undefined;
    }
    return out;
  }

  if (provider === 'dropbox') {
    const ref = folderId.trim();
    let url = 'https://api.dropboxapi.com/2/files/list_folder';
    let body = JSON.stringify({ path: ref === 'root' || ref === '' ? '' : ref, recursive: false, limit: 200 });
    const out: BrowseFolder[] = [];
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const r = await brokeredFetch(egressDeps, { provider: 'dropbox', url, method: 'POST', body });
      failClosed(r, 'dropbox');
      const json = (await readJson(r)) as { entries?: unknown; cursor?: unknown; has_more?: unknown } | undefined;
      for (const e of Array.isArray(json?.entries) ? json.entries : []) { const rec = e as Record<string, unknown>; if (rec['.tag'] !== 'folder') continue; pushName(out, typeof rec.id === 'string' ? rec.id : '', rec.name); if (out.length >= MAX_LIST_FILES) return out; }
      if (json?.has_more !== true || typeof json.cursor !== 'string') break;
      url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
      body = JSON.stringify({ cursor: json.cursor });
    }
    return out;
  }

  if (provider === 'box') {
    const id = folderId.trim() === 'root' || folderId.trim() === '' ? '0' : safeBoxId(folderId, 'folder');
    const out: BrowseFolder[] = [];
    const limit = 1000;
    let offset = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const r = await brokeredFetch(egressDeps, { provider: 'box', url: `https://api.box.com/2.0/folders/${id}/items?fields=id%2Cname%2Ctype&limit=${limit}&offset=${offset}` });
      failClosed(r, 'box');
      const json = (await readJson(r)) as { entries?: unknown; total_count?: unknown } | undefined;
      const entries = Array.isArray(json?.entries) ? json.entries : [];
      for (const e of entries) { const rec = e as Record<string, unknown>; if (rec.type !== 'folder') continue; pushName(out, typeof rec.id === 'string' ? rec.id : '', rec.name); if (out.length >= MAX_LIST_FILES) return out; }
      offset += limit;
      // Same drain rule as the sync lister (ADR 0605 R1) — the `total_count ??
      // entries.length` fallback ended the walk on any full page.
      if (boxDrained(entries.length, limit, offset, json?.total_count)) break;
    }
    return out;
  }

  throw new OpenwopError('validation_error', `Folder browsing is not supported for provider '${provider}'.`, 400, { provider });
}

/** OneDrive/Graph item ids are URL-safe-ish (`[A-Za-z0-9!._~-]`); `root` is the
 *  drive root. Validate so a crafted id can NOT traverse the Graph path (the id
 *  goes in `/me/drive/items/<id>/…`). */
const GRAPH_ID_RE = /^[A-Za-z0-9!._~-]+$/;

/** Reject a Graph id that's empty, off-charset, or a `..` traversal (`encodeURIComponent`
 *  leaves dots intact, so `..` would traverse the Graph path). */
function safeGraphId(id: string, label: string, ctx: Record<string, unknown>): string {
  if (!GRAPH_ID_RE.test(id) || id.includes('..')) {
    throw new OpenwopError('validation_error', `Invalid ${label}.`, 400, ctx);
  }
  return encodeURIComponent(id);
}

/**
 * Build the Graph item base URL for a sync folder ref. OneDrive (`microsoft-graph`)
 * addresses the acting user's default drive (`/me/drive`); SharePoint
 * (`microsoft-sharepoint`) addresses a document-library drive by id —
 * `{driveId}` (library root) or `{driveId}:{itemId}` (a subfolder) → `/drives/{driveId}…`.
 * Both ride the SAME `microsoft-graph` connection + egress (only the path differs).
 */
function graphItemsBase(syncProvider: string, ref: string): string {
  const id = ref.trim();
  if (!id) throw new OpenwopError('validation_error', 'A folder id is required.', 400, {});
  if (syncProvider === 'microsoft-sharepoint') {
    const sep = id.indexOf(':');
    const driveId = sep === -1 ? id : id.slice(0, sep);
    const itemId = sep === -1 ? '' : id.slice(sep + 1);
    const driveBase = `https://graph.microsoft.com/v1.0/drives/${safeGraphId(driveId, 'SharePoint drive id', { ref })}`;
    return itemId ? `${driveBase}/items/${safeGraphId(itemId, 'SharePoint item id', { ref })}` : `${driveBase}/root`;
  }
  // microsoft-graph (OneDrive) — the acting user's default drive.
  if (id === 'root') return 'https://graph.microsoft.com/v1.0/me/drive/root';
  return `https://graph.microsoft.com/v1.0/me/drive/items/${safeGraphId(id, 'OneDrive folder id', { folderId: ref })}`;
}

async function listOneDriveFolder(deps: KnowledgeFetchDeps, syncProvider: string, folderId: string): Promise<SyncFolderListing> {
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  const select = encodeURIComponent('id,name,file,folder,lastModifiedDateTime');
  let url: string | undefined = `${graphItemsBase(syncProvider, folderId)}/children?$select=${select}&$top=200`;
  const out: SyncFolderFile[] = [];
  for (let page = 0; page < MAX_LIST_PAGES && url; page += 1) {
    const r = await brokeredFetch(egressDeps, { provider: 'microsoft-graph', url });
    failClosed(r, 'microsoft-graph');
    const body = (await readJson(r)) as { value?: unknown; ['@odata.nextLink']?: unknown } | undefined;
    // ADR 0605 R1 — an OData collection always carries `value`, even when empty;
    // a `2xx` without it is a response we could not read, not an empty folder.
    const items = listingArray(body, 'value', 'Microsoft Graph');
    for (const it of items) {
      const rec = it as Record<string, unknown>;
      const fileId = typeof rec.id === 'string' ? rec.id : '';
      // FILES only — a `folder` facet means a subfolder (no recursion, OQ-2).
      if (!fileId || rec.folder || !rec.file) continue;
      const file = rec.file as { mimeType?: unknown };
      out.push({
        fileId,
        name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled',
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : '',
        revision: typeof rec.lastModifiedDateTime === 'string' ? rec.lastModifiedDateTime : '',
      });
      if (out.length >= MAX_LIST_FILES) return partialListing(out, 'file_cap'); // hard cap (OQ-3)
    }
    const next = body?.['@odata.nextLink'];
    if (next === undefined || next === null) return completeListing(out); // no more pages — drained
    // A nextLink that is present but NOT a graph.microsoft.com URL is refused (an
    // open-redirect guard). Refusing it is right; treating the listing as COMPLETE
    // afterwards was not — the folder demonstrably has more files.
    if (typeof next !== 'string' || !next.startsWith('https://graph.microsoft.com/')) {
      return partialListing(out, 'bad_page_token');
    }
    url = next;
  }
  return partialListing(out, 'page_budget');
}

/** Drive file/folder ids are URL-safe base64-ish (`[A-Za-z0-9_-]`). Validate the
 *  charset so a folderId can NOT inject into the `'<id>' in parents` Drive query
 *  (a `'` would otherwise let a crafted id list a different folder). */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

async function listGoogleDriveFolder(deps: KnowledgeFetchDeps, folderId: string): Promise<SyncFolderListing> {
  const id = folderId.trim();
  if (!id) {
    throw new OpenwopError('validation_error', 'A Drive folder id is required.', 400, {});
  }
  if (!DRIVE_ID_RE.test(id)) {
    throw new OpenwopError('validation_error', 'Invalid Drive folder id.', 400, { folderId });
  }
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  // Files only — exclude subfolders (no recursion, OQ-2); mirrors the OneDrive list's folder skip.
  const q = encodeURIComponent(`'${id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`);
  // `kind` is requested DELIBERATELY (ADR 0605 R1): it is what lets an empty
  // Drive folder be told apart from a body that is not a Drive listing at all.
  // See `driveListingFiles`.
  const fields = encodeURIComponent(`kind,nextPageToken,files(id,name,mimeType,modifiedTime)`);
  const out: SyncFolderFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}` +
      `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const r = await brokeredFetch(egressDeps, { provider: 'google', url });
    failClosed(r, 'google');
    const body = (await readJson(r)) as { files?: unknown; nextPageToken?: unknown } | undefined;
    // ADR 0605 R1 — a `2xx` that is not a Drive file list is not an empty folder.
    const files = driveListingFiles(body);
    for (const f of files) {
      const rec = f as Record<string, unknown>;
      const fileId = typeof rec.id === 'string' ? rec.id : '';
      if (!fileId) continue;
      out.push({
        fileId,
        name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled',
        mimeType: typeof rec.mimeType === 'string' ? rec.mimeType : '',
        revision: typeof rec.modifiedTime === 'string' ? rec.modifiedTime : '',
      });
      // Hard cap (OQ-3) — bound a huge folder. INCOMPLETE: files past the cap
      // still exist remotely, so the caller must not read their absence as a
      // deletion (`KSC-3`).
      if (out.length >= MAX_LIST_FILES) return partialListing(out, 'file_cap');
    }
    pageToken = typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) return completeListing(out);
  }
  // Fell out of the page loop with a token still pending ⇒ more files exist.
  return partialListing(out, 'page_budget');
}

/** Text-extractable mime types we read directly as text, rather than downloading
 *  bytes for `kbService.extractTextFromBytes`.
 *
 *  ADR 0605 Tier 7 (`KSC-13`) — this used to add *"Office/PDF binary extraction via
 *  the KB extractor is a follow-on"*. It shipped 2026-06-23: everything NOT matched
 *  here routes to `fetchKnowledgeSourceBytes` → the extractor, which is the whole
 *  point of the split. The stale clause made the false half look like the design. */
function isTextMime(m: string): boolean {
  return m.startsWith('text/') || m === 'application/json' || m === 'application/xml' || m === 'application/markdown';
}

async function fetchOneDriveItem(deps: KnowledgeFetchDeps, syncProvider: string, ref: string): Promise<FetchedSource> {
  const egressDeps = {
    storage: deps.storage,
    tenantId: deps.tenantId,
    runId: SYNTHETIC_RUN_ID,
    actingUserId: deps.actingUserId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  };
  const base = graphItemsBase(syncProvider, ref); // validates the item id

  // 1) meta → name + mimeType (also the cheapest access/connection probe).
  const meta = await brokeredFetch(egressDeps, { provider: 'microsoft-graph', url: `${base}?$select=name,file` });
  failClosed(meta, 'microsoft-graph');
  const metaJson = (await readJson(meta)) as { name?: unknown; file?: { mimeType?: unknown } } | undefined;
  const name = typeof metaJson?.name === 'string' && metaJson.name.trim() ? metaJson.name.trim() : 'OneDrive file';
  const mimeType = typeof metaJson?.file?.mimeType === 'string' ? metaJson.file.mimeType : '';
  if (!isTextMime(mimeType)) {
    throw new OpenwopError('validation_error', `OneDrive file type '${mimeType || 'unknown'}' has no extractable text. Use a text or markdown file.`, 400, { ref, mimeType });
  }

  // 2) content
  const content = await brokeredFetch(egressDeps, { provider: 'microsoft-graph', url: `${base}/content` });
  failClosed(content, 'microsoft-graph');
  const text = await readText(content);
  if (!text.trim()) throw new OpenwopError('validation_error', 'The OneDrive file has no readable text content.', 400, { ref });
  return { title: name, text, sourceUrl: `${base}/content` };
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
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft-graph') return 'Microsoft OneDrive';
  return provider;
}

async function readText(r: Sent): Promise<string> {
  const body = await r.res.text();
  return body.length > MAX_FETCH_BYTES ? body.slice(0, MAX_FETCH_BYTES) : body;
}

/** Decoded-byte cap on a downloaded binary — matches kbService's MAX_UPLOAD_DECODED_BYTES
 *  so a fetched file that ingests at all also fits the ingest cap. */
const MAX_BINARY_FETCH_BYTES = 32 * 1024 * 1024;
/** KSC-8 — this call site had no timeout at all; a provider that accepts the
 *  connection and never finishes the body hung the sync tick indefinitely. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Bounded because the arms are now per hop: an unbounded chain is a way to
 *  spend the timeout budget without ever downloading anything. */
const MAX_DOWNLOAD_REDIRECTS = 5;
/** Audio gets the larger sync cap (ADR 0111) — long recordings transcribe via the File API,
 *  mirroring kbService's MAX_AUDIO_DECODED_BYTES so a synced long audio also fits ingest. */
const MAX_AUDIO_FETCH_BYTES = 200 * 1024 * 1024;

/** Read a response as bytes — REJECTS on oversize. Unlike `readText` (which slices —
 *  partial text is still text), a truncated binary is a CORRUPT file, so an oversize
 *  download throws (becomes a per-file sync error, never a corrupt ingest). Takes a bare
 *  `{arrayBuffer}` so it serves both the brokered `Sent.res` and the raw (un-credentialed
 *  Graph downloadUrl) fetch Response. */
async function readBytes(res: { arrayBuffer(): Promise<ArrayBuffer> }, maxBytes = MAX_BINARY_FETCH_BYTES): Promise<Buffer> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new OpenwopError(
      'validation_error',
      `File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB sync cap.`,
      413,
      { maxBytes },
    );
  }
  return buf;
}

/**
 * Parse a transport-SUCCESS body as JSON — THROWS a typed error when it is not
 * parseable (ADR 0605 Tier 1 / `KSC-1`, `KSC-5`).
 *
 * THE BUG THIS EXISTS TO MAKE UNREPRESENTABLE. This used to `return undefined`
 * on a parse failure. Every caller then read `json?.field`, so an unparseable
 * `200` — an interposing proxy, a captive portal, a provider HTML error page —
 * degraded to "the provider returned nothing". On the four FOLDER-LISTING
 * callers that became an EMPTY listing, which `diffFolder` correctly classifies
 * as *every previously-synced file was deleted*, which the runner executes as
 * `deleteDocument` per row. Measured by the feature-31 assessment: `[]` against
 * 500 prior file-states emits 500 prunes.
 *
 * Every HARD failure on this path was already fail-closed (`failClosed`), which
 * is exactly why the soft one was dangerous: the loud failures were designed and
 * this quiet one read as success.
 *
 * Callers affected — the FULL population, enumerated by call graph (this
 * function is module-private; `grep readJson` over `src/` + `test/` finds no
 * importer, and the three same-named functions elsewhere in the repo are
 * unrelated locals):
 *   - 4 folder listers (`listGoogleDriveFolder`, `listOneDriveFolder`,
 *     `listDropboxFolder`, `listBoxFolder`) — the destructive lane. Now the
 *     whole listing throws, `syncNow` records `error`, and NOTHING is pruned.
 *   - 4 `browseFolders` branches — the picker now surfaces a 502 instead of
 *     painting an empty folder tree (a lie, though not a destructive one).
 *   - 6 single-file meta/link reads. FOUR of those already threw one step later
 *     on the `undefined`-derived value (`fetchGoogleDriveDoc` via an unsupported
 *     empty mimeType, `fetchOneDriveItem` likewise, `fetchOneDriveBytes` and
 *     `fetchDropboxBytes` on a missing download URL) — for those this only
 *     improves the message. The other TWO silently degraded and now fail closed:
 *     `fetchGoogleDriveBytes` ingested the file as `application/octet-stream`
 *     under the title "Drive file", and `fetchBoxBytes` ingested it titled
 *     "Box file". Both were garbage-in-the-KB paths.
 * Cross-feature blast radius: `features/agent-knowledge/service.ts:292` calls
 * `fetchKnowledgeSource` (the text lane). It previously surfaced a misleading
 * "no extractable text" 400 in this case and now surfaces this 502 — the same
 * failure outcome, an accurate reason.
 */
async function readJson(r: Sent): Promise<unknown> {
  const body = await readText(r);
  try {
    return JSON.parse(body);
  } catch {
    throw new OpenwopError(
      'internal_error',
      'The provider returned a success status with a body that is not JSON. Refusing to treat it as an empty result.',
      502,
      { status: r.res.status },
    );
  }
}
