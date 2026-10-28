/**
 * ADR 0119 Phase 4a — pure conversation IMPORT parsers.
 *
 * Normalizes an external transcript into `{ title, turns }` for the importer
 * (Phase 4b: `conversations/open` + `appendChatMessage`, untrusted-stamped). Two
 * formats: the round-trippable `openwop-v1` export (this app's own) + the
 * OpenAI/ChatGPT `conversations.json` shape (mapping/`current_node` tree). Pure +
 * deterministic — no I/O, no store. A hostile import is stamped untrusted at the
 * WRITE step (Phase 4b), not here; the parser only normalizes shape.
 *
 * ADR 0992 D7 — a malformed input is an `OpenwopError` 400 (it was a plain `Error`,
 * which the error middleware mapped to a 500). An ARRAY is a ChatGPT data-export
 * archive (`conversations.json` holds every conversation); the SPA picks one
 * conversation client-side, so the route refuses an archive with
 * `details.reason: 'archive'`.
 *
 * @see docs/adr/0119-conversation-export-import.md
 * @see docs/adr/0992-chat-export-import-fidelity-and-trust.md
 */
import { OpenwopError } from '../../types.js';

export interface ImportedTurn { role: string; content: string; createdAt?: string }
export interface ImportedConversation { title: string; turns: ImportedTurn[] }

const ROLES = new Set(['user', 'assistant', 'system']);

function invalid(message: string, reason: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { field: 'data', reason });
}

/** Parse this app's own `openwop-v1` JSON export (the round-trip path). */
export function parseOpenwopExport(input: unknown): ImportedConversation {
  if (Array.isArray(input)) throw invalid('This is an archive of several conversations — import one conversation at a time.', 'archive');
  const o = input as { version?: unknown; conversation?: { title?: unknown }; messages?: unknown } | null;
  if (!o || o.version !== 'openwop-v1' || !Array.isArray(o.messages)) {
    throw invalid('Not an OpenWOP conversation export (openwop-v1).', 'not_openwop');
  }
  const title = typeof o.conversation?.title === 'string' ? o.conversation.title : 'Imported conversation';
  const turns: ImportedTurn[] = [];
  for (const m of o.messages as Array<{ role?: unknown; content?: unknown; createdAt?: unknown }>) {
    if (typeof m?.content !== 'string') continue;
    // ADR 0992 D2 — the role is carried through as written; the importer (not the
    // parser) decides what it will store. Defaulting an unknown role to 'user' made
    // an exported workflow card re-import as something the person "said".
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    turns.push({ role, content: m.content, ...(typeof m.createdAt === 'string' ? { createdAt: m.createdAt } : {}) });
  }
  return { title, turns };
}

/** Parse an OpenAI/ChatGPT `conversations.json` entry (mapping tree → linear path
 *  via `current_node`, the LibreChat fork.js shape). Best-effort: unknown nodes
 *  are skipped, never throw on a partial tree. */
export function parseChatGptExport(input: unknown): ImportedConversation {
  if (Array.isArray(input)) throw invalid('This is a ChatGPT archive of several conversations — import one conversation at a time.', 'archive');
  const o = input as { title?: unknown; mapping?: Record<string, unknown>; current_node?: unknown } | null;
  if (!o || typeof o.mapping !== 'object' || !o.mapping) {
    throw invalid('Not a ChatGPT conversation export.', 'not_chatgpt');
  }
  const title = typeof o.title === 'string' && o.title.trim() ? o.title : 'Imported conversation';
  // Walk parent links from current_node to the root, then reverse → chronological.
  // CONV-5: an explicit node ceiling (defense-in-depth on top of the cycle guard + the
  // write-side MAX_TURNS cap) so a pathologically large mapping can't build an unbounded
  // chain before the write truncates it.
  const MAX_NODES = 10_000;
  const chain: ImportedTurn[] = [];
  let node = typeof o.current_node === 'string' ? o.current_node : undefined;
  const guard = new Set<string>();
  while (node && !guard.has(node) && guard.size < MAX_NODES) {
    guard.add(node);
    const entry = (o.mapping as Record<string, { message?: { author?: { role?: unknown }; content?: { parts?: unknown }; create_time?: unknown }; parent?: unknown }>)[node];
    const msg = entry?.message;
    const role = typeof msg?.author?.role === 'string' && ROLES.has(msg.author.role) ? msg.author.role : undefined;
    const parts = msg?.content?.parts;
    const text = Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string').join('\n') : '';
    const ct = msg?.create_time;
    const ms = typeof ct === 'number' ? ct * 1000 : NaN;
    const createdAt = ms > 0 && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined;
    if (role && text.trim()) chain.push({ role, content: text, ...(createdAt ? { createdAt } : {}) });
    node = typeof entry?.parent === 'string' ? entry.parent : undefined;
  }
  chain.reverse();
  return { title, turns: chain };
}
