/**
 * ADR 0119 Phase 1 — pure transcript renderer (markdown / JSON).
 *
 * Deterministic, I/O-free projection of `(ChatSessionRecord, ChatMessageRecord[])`
 * — the ADR 0102 persisted transcript is the source of truth; this never stores
 * anything. Structured message content (interrupt / A2UI cards) renders as a fenced
 * JSON block in markdown; plain text renders inline. The JSON form is the
 * round-trippable `openwop-v1` export shape the importer (Phase 4) reads.
 */
import type { ChatSessionRecord, ChatMessageRecord } from '../../types.js';

export const EXPORT_FORMAT_VERSION = 'openwop-v1';

/** Robust plain-text projection of a stored message content (string / `{content}`
 *  / parts array). Returns the raw string when it isn't JSON. */
function messageText(content: string): string {
  if (!content) return '';
  const t = content.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return content;
  try {
    return flatten(JSON.parse(content)).trim() || content;
  } catch {
    return content;
  }
}

function flatten(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(flatten).join(' ');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return flatten(o.content);
    return Object.values(o).map(flatten).join(' ');
  }
  return '';
}

/** True when the content is a structured card (object/array), not plain text — it
 *  renders as a fenced JSON block in markdown to preserve the card. */
function isStructured(content: string): boolean {
  const t = content.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { const p = JSON.parse(content); return typeof p === 'object' && p !== null; } catch { return false; }
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user': return 'User';
    case 'assistant': return 'Assistant';
    case 'system': return 'System';
    case 'workflow_run': return 'Workflow';
    default: return role;
  }
}

/** Render the transcript as Markdown. Deterministic — message order preserved. */
export function transcriptToMarkdown(session: ChatSessionRecord, messages: readonly ChatMessageRecord[]): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || 'Conversation'}`);
  lines.push('');
  lines.push(`> Exported from OpenWOP · conversation \`${session.sessionId}\` · ${messages.length} message(s)`);
  lines.push('');
  for (const m of messages) {
    lines.push(`## ${roleLabel(m.role)} — ${m.createdAt}`);
    lines.push('');
    if (isStructured(m.content)) {
      lines.push('```json');
      lines.push(m.content);
      lines.push('```');
    } else {
      lines.push(messageText(m.content));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** The structured `openwop-v1` JSON export (round-trippable by the importer). */
export interface TranscriptExport {
  version: typeof EXPORT_FORMAT_VERSION;
  conversation: { sessionId: string; title: string; createdAt: string };
  messages: Array<{ role: string; content: string; authorSubject: string | null; createdAt: string }>;
}

export function transcriptToJson(session: ChatSessionRecord, messages: readonly ChatMessageRecord[]): TranscriptExport {
  return {
    version: EXPORT_FORMAT_VERSION,
    conversation: { sessionId: session.sessionId, title: session.title, createdAt: session.createdAt },
    messages: messages.map((m) => ({ role: m.role, content: m.content, authorSubject: m.authorSubject, createdAt: m.createdAt })),
  };
}
