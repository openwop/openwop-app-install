/**
 * Gemini File API (ADR 0111) — upload large media once, reference it by `fileUri` in a
 * generateContent request instead of inlining the bytes. Used by `dispatchGoogle` for
 * long-form audio that exceeds the inline request limit.
 *
 * Standalone (imports nothing from `dispatch.ts`) so there is no import cycle. Throws plain
 * Errors on any failure (bad upload, FAILED state, poll timeout); the caller's transcription
 * try/catch maps them to a clean 422. SR-1: the key only ever hits the Gemini host; the
 * returned `fileUri` is a Gemini-issued handle we only send back to Gemini (no egress).
 */

const BASE = 'https://generativelanguage.googleapis.com';
/** Bounded poll: a stuck/processing upload fails the transcription rather than hanging. */
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30; // ≤ 60s
/** Resumable-upload chunk size — must be a multiple of 256 KiB (Gemini protocol) except the
 *  last. Bounds the per-request upload footprint regardless of file size (ADR 0111 OQ-C). */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

interface GeminiFile { name?: string; uri?: string; state?: string; mimeType?: string }

/**
 * Upload `bytes` to the File API (resumable: start → upload+finalize), wait until the file is
 * ACTIVE (server-side processing), and return its `fileUri`. Bounded; throws on failure.
 */
export async function uploadAndWaitActive(bytes: Buffer, mimeType: string, apiKey: string, signal?: AbortSignal): Promise<{ uri: string; name: string }> {
  // 1) start — returns the resumable upload URL in a response header.
  const start = await fetch(`${BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'openwop-media' } }),
    ...(signal ? { signal } : {}),
  });
  if (!start.ok) throw new Error(`gemini_file_start_${start.status}: ${(await start.text()).slice(0, 200)}`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('gemini_file_no_upload_url');

  // 2) upload the bytes in CHUNKS (ADR 0111 OQ-C, Phase 1) — each chunk is a zero-copy
  // `subarray` VIEW, and we never wrap the whole buffer in a fresh `Uint8Array`, so the
  // upload adds no full-size copy on top of the (already-held) decoded buffer, and undici
  // only buffers one chunk at a time. The last chunk carries `finalize` + returns the file.
  let uploaded: GeminiFile = {};
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.length));
    const isLast = offset + UPLOAD_CHUNK_BYTES >= bytes.length;
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload', 'X-Goog-Upload-Offset': String(offset), 'content-length': String(chunk.length) },
      body: chunk,
      ...(signal ? { signal } : {}),
    });
    if (!up.ok) throw new Error(`gemini_file_upload_${up.status}: ${(await up.text()).slice(0, 200)}`);
    if (isLast) uploaded = ((await up.json()) as { file?: GeminiFile }).file ?? {};
  }
  if (!uploaded.name || !uploaded.uri) throw new Error('gemini_file_no_name_or_uri');

  // 3) poll until ACTIVE (audio is transcoded server-side). Bounded — never hang.
  if (uploaded.state === 'ACTIVE') return { uri: uploaded.uri, name: uploaded.name };
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS, signal);
    const r = await fetch(`${BASE}/v1beta/${uploaded.name}`, { headers: { 'x-goog-api-key': apiKey }, ...(signal ? { signal } : {}) });
    if (!r.ok) throw new Error(`gemini_file_status_${r.status}`);
    const f = (await r.json()) as GeminiFile;
    if (f.state === 'ACTIVE') return { uri: uploaded.uri, name: uploaded.name };
    if (f.state === 'FAILED') throw new Error('gemini_file_processing_failed');
  }
  throw new Error('gemini_file_active_timeout');
}

/** Best-effort delete of an uploaded file (ADR 0111 follow-on) — keeps a heavy tenant from
 *  piling up against the File-API storage quota (files otherwise auto-expire after 48 h).
 *  Never throws: cleanup failure must not affect the transcription result. */
export async function deleteGeminiFile(name: string, apiKey: string): Promise<void> {
  try {
    await fetch(`${BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': apiKey } });
  } catch { /* best-effort */ }
}
