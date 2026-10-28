/**
 * ADR 0119 Phase 5 — FE export + import. The feature is always-on (ADR 0134); the
 * server decides who may read a conversation.
 *
 * ADR 0992 D9: the download is named by the server (`Content-Disposition`, from the
 * title). An import carries an idempotency key (a digest of the file plus the chosen
 * conversation), so a retry or double click opens the same conversation. Errors are
 * typed, so the chat can say WHY an import failed. A ChatGPT data export is an archive
 * of every conversation; it is listed here, and one conversation is sent at a time.
 */
import { config, authedHeaders, fetchOpts } from './config.js';

/** `filename="…"` from a Content-Disposition header, or null. */
export function fileNameFromDisposition(header: string | null): string | null {
  const m = header ? /filename="([^"]+)"/.exec(header) : null;
  return m && /^[A-Za-z0-9._-]+$/.test(m[1]!) ? m[1]! : null;
}

/** Download the conversation transcript as markdown or JSON. Throws on a non-OK
 *  response so the caller can surface an error. */
export async function exportConversation(sessionId: string, format: 'md' | 'json'): Promise<void> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/chat-export/${encodeURIComponent(sessionId)}?format=${format}`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`export_failed_${res.status}`);
  const text = await res.text();
  const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameFromDisposition(res.headers.get('content-disposition')) ?? `conversation.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ImportResult {
  sessionId: string;
  imported: number;
  skipped: number;
  truncated: number;
  replayed: boolean;
}

/** Why an import failed, in terms the chat can put into words. */
export type ImportFailure = 'too_large' | 'unsupported' | 'empty' | 'not_json' | 'conflict' | 'failed';

export class ChatImportError extends Error {
  constructor(public readonly failure: ImportFailure, public readonly status?: number) {
    super(`import_failed_${failure}`);
    this.name = 'ChatImportError';
  }
}

/** Import one conversation (`data` is its parsed JSON) into a NEW conversation. */
export async function importConversation(
  format: 'openwop' | 'chatgpt',
  data: unknown,
  idempotencyKey?: string,
): Promise<ImportResult> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/chat-export/import`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ format, data, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  }));
  if (!res.ok) {
    let reason: unknown;
    try { reason = ((await res.json()) as { details?: { reason?: unknown } }).details?.reason; } catch { /* not JSON */ }
    if (res.status === 413) throw new ChatImportError('too_large', 413);
    if (res.status === 409) throw new ChatImportError('conflict', 409);
    if (reason === 'empty') throw new ChatImportError('empty', res.status);
    if (res.status === 400) throw new ChatImportError('unsupported', 400);
    throw new ChatImportError('failed', res.status);
  }
  return res.json() as Promise<ImportResult>;
}

/** Detect the export format of ONE conversation (openwop-v1 round-trip vs an OpenAI
 *  export tree). Defaults to 'openwop'. */
export function detectImportFormat(data: unknown): 'openwop' | 'chatgpt' {
  const o = data as { version?: unknown; mapping?: unknown } | null;
  if (o && typeof o === 'object' && o.mapping && typeof o.mapping === 'object') return 'chatgpt';
  return 'openwop';
}

/** A ChatGPT data export's `conversations.json`: an array of conversation trees. */
export function isChatGptArchive(data: unknown): data is unknown[] {
  return Array.isArray(data) && data.length > 0 && data.every((c) => detectImportFormat(c) === 'chatgpt');
}

export interface ArchiveEntry {
  index: number;
  title: string;
  /** ISO time the conversation started, when the export says. */
  createdAt?: string;
  /** User/assistant messages with text, over the whole tree (branches included, so an upper bound). */
  messageCount: number;
}

/** List an archive's conversations, newest first, for the person to choose one. */
export function listArchiveConversations(archive: readonly unknown[]): ArchiveEntry[] {
  return archive
    .map((raw, index): ArchiveEntry => {
      const c = (raw ?? {}) as { title?: unknown; create_time?: unknown; mapping?: Record<string, { message?: { author?: { role?: unknown }; content?: { parts?: unknown } } | null }> };
      const ms = typeof c.create_time === 'number' ? c.create_time * 1000 : NaN;
      const createdAt = ms > 0 && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined;
      // Only what the server stores (user/assistant turns with text), so the count
      // the picker shows is the count the import reports.
      const messageCount = Object.values(c.mapping ?? {}).filter((n) => {
        const role = n?.message?.author?.role;
        if (role !== 'user' && role !== 'assistant') return false;
        const parts = n?.message?.content?.parts;
        return Array.isArray(parts) && parts.some((p) => typeof p === 'string' && p.trim().length > 0);
      }).length;
      return {
        index,
        title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : '',
        ...(createdAt ? { createdAt } : {}),
        messageCount,
      };
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** A digest of the file's text for the idempotency key, or undefined where the
 *  browser has no SubtleCrypto (an insecure origin). Without a key the import still
 *  works; it just is not deduplicated. */
export async function fileDigest(text: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 64);
}
