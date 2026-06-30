/**
 * ADR 0119 Phase 5 — FE export. Fetches the caller's own/participant conversation
 * transcript from the Phase-2 export route and triggers a browser download. Read-only;
 * toggle-gated server-side (`chat-export` OFF ⇒ 404), so the button is also gated.
 */
import { config, authedHeaders, fetchOpts } from './config.js';

/** Download the conversation transcript as markdown or JSON. Best-effort: throws on a
 *  non-OK response so the caller can surface an error. */
export async function exportConversation(sessionId: string, format: 'md' | 'json'): Promise<void> {
  const res = await fetch(
    `${config.baseUrl}/v1/host/openwop-app/chat-export/${encodeURIComponent(sessionId)}?format=${format}`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`export_failed_${res.status}`);
  const text = await res.text();
  const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${sessionId}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** ADR 0119 — import a parsed export into a NEW conversation. `data` is the parsed file
 *  JSON; `format` selects the parser ('openwop' round-trip, or 'chatgpt'). Returns the
 *  new session id. Throws on a non-OK response. */
export async function importConversation(format: 'openwop' | 'chatgpt', data: unknown): Promise<{ sessionId: string; imported: number }> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/chat-export/import`, fetchOpts({
    method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ format, data }),
  }));
  if (!res.ok) throw new Error(`import_failed_${res.status}`);
  return res.json() as Promise<{ sessionId: string; imported: number }>;
}

/** Detect the export format from the parsed JSON (openwop-v1 round-trip vs an OpenAI
 *  export tree). Defaults to 'openwop'. */
export function detectImportFormat(data: unknown): 'openwop' | 'chatgpt' {
  const o = data as { version?: unknown; mapping?: unknown } | null;
  if (o && typeof o === 'object' && o.mapping && typeof o.mapping === 'object') return 'chatgpt';
  return 'openwop';
}
