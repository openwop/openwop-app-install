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
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';

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
 * from `googleapis.com`. OneDrive byte download is a follow-on — Graph `/content`
 * 302s to a separate download host, which the no-follow-redirect broker can't fetch
 * (it would need the `@microsoft.graph.downloadUrl` + a Microsoft-download-host SSRF
 * guard).
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
 * token-leak-on-redirect risk), https-only, 32MB cap.
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
  const bytes = await fetchGuardedBytes(downloadUrl, 'OneDrive', maxBytes);
  return { title: name, contentBase64: bytes.toString('base64'), contentType, sourceUrl: `${base}/content` };
}

/** Fetch a PRE-AUTHENTICATED download URL (no credential) through the host SSRF egress
 *  guard — https-only, private-IP-blocked, the pinned dispatcher re-validates each
 *  redirect hop, 32MB cap. Shared by every "temp/pre-auth download URL" provider
 *  (OneDrive/SharePoint `@microsoft.graph.downloadUrl`, Dropbox `get_temporary_link`). */
async function fetchGuardedBytes(downloadUrl: string, label: string, maxBytes = MAX_BINARY_FETCH_BYTES): Promise<Buffer> {
  let url: URL;
  try { url = new URL(downloadUrl); } catch { throw new OpenwopError('validation_error', `Malformed ${label} download URL.`, 502, {}); }
  if (url.protocol !== 'https:') throw new OpenwopError('validation_error', `${label} download URL must be https.`, 502, {});
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) {
    throw new OpenwopError('validation_error', `${label} download host is not permitted.`, 502, { host: url.hostname });
  }
  const res = await undiciFetch(downloadUrl, { dispatcher: webhookEgressDispatcher() });
  if (!res.ok) throw new OpenwopError('internal_error', `${label} download failed (HTTP ${res.status}).`, 502, { status: res.status });
  return readBytes(res, maxBytes);
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

async function listDropboxFolder(deps: KnowledgeFetchDeps, folderId: string): Promise<SyncFolderFile[]> {
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
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    for (const e of entries) {
      const rec = e as Record<string, unknown>;
      if (rec['.tag'] !== 'file') continue; // files only (skip folders — no recursion)
      const id = typeof rec.id === 'string' ? rec.id : '';
      const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled';
      if (!id) continue;
      out.push({ fileId: id, name, mimeType: mimeFromName(name), revision: typeof rec.rev === 'string' ? rec.rev : (typeof rec.content_hash === 'string' ? rec.content_hash : '') });
      if (out.length >= MAX_LIST_FILES) return out;
    }
    if (json?.has_more !== true || typeof json.cursor !== 'string') break;
    url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
    body = JSON.stringify({ cursor: json.cursor });
  }
  return out;
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
  const bytes = await fetchGuardedBytes(link, 'Dropbox', maxBytes);
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

async function listBoxFolder(deps: KnowledgeFetchDeps, folderId: string): Promise<SyncFolderFile[]> {
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
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    for (const e of entries) {
      const rec = e as Record<string, unknown>;
      if (rec.type !== 'file') continue; // files only (skip folders — no recursion)
      const fid = typeof rec.id === 'string' ? rec.id : '';
      if (!fid) continue;
      const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Untitled';
      out.push({ fileId: fid, name, mimeType: mimeFromName(name), revision: typeof rec.etag === 'string' ? rec.etag : (typeof rec.modified_at === 'string' ? rec.modified_at : '') });
      if (out.length >= MAX_LIST_FILES) return out;
    }
    const total = typeof json?.total_count === 'number' ? json.total_count : entries.length;
    offset += limit;
    if (entries.length === 0 || offset >= total) break;
  }
  return out;
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
  const bytes = await fetchGuardedBytes(location, 'Box', maxBytes);
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
const MAX_LIST_FILES = 1000;
const MAX_LIST_PAGES = 20;

/** List the non-trashed files DIRECTLY under a connected drive folder, via the
 *  SSRF-guarded Connections broker (no token handling here — same egress path as
 *  `fetchKnowledgeSource`). Top-level only (no recursion — ADR 0107 OQ-2 default).
 *  v1 supports Google Drive; OneDrive (`microsoft365`) is a later phase. The
 *  result feeds the `knowledge-sync.run` diff (NEW/CHANGED/DELETED) in Phase 3. */
export async function listFolder(deps: KnowledgeFetchDeps, provider: string, folderId: string): Promise<SyncFolderFile[]> {
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
      const total = typeof json?.total_count === 'number' ? json.total_count : entries.length;
      offset += limit;
      if (entries.length === 0 || offset >= total) break;
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

async function listOneDriveFolder(deps: KnowledgeFetchDeps, syncProvider: string, folderId: string): Promise<SyncFolderFile[]> {
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
    const items = Array.isArray(body?.value) ? body.value : [];
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
      if (out.length >= MAX_LIST_FILES) return out; // hard cap (OQ-3)
    }
    const next = body?.['@odata.nextLink'];
    url = typeof next === 'string' && next.startsWith('https://graph.microsoft.com/') ? next : undefined;
  }
  return out;
}

/** Drive file/folder ids are URL-safe base64-ish (`[A-Za-z0-9_-]`). Validate the
 *  charset so a folderId can NOT inject into the `'<id>' in parents` Drive query
 *  (a `'` would otherwise let a crafted id list a different folder). */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

async function listGoogleDriveFolder(deps: KnowledgeFetchDeps, folderId: string): Promise<SyncFolderFile[]> {
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
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime)');
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
    const files = Array.isArray(body?.files) ? body.files : [];
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
      if (out.length >= MAX_LIST_FILES) return out; // hard cap (OQ-3) — bound a huge folder
    }
    pageToken = typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

/** Text-extractable mime types we read directly (mirrors the Drive text-only
 *  support; Office/PDF binary extraction via the KB extractor is a follow-on). */
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

async function readJson(r: Sent): Promise<unknown> {
  try {
    return JSON.parse(await readText(r));
  } catch {
    return undefined;
  }
}
