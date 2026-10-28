/**
 * ADR 0119 Phase 1 — pure transcript renderer (markdown / JSON).
 *
 * Deterministic, I/O-free projection of `(ChatSessionRecord, ChatMessageRecord[])`
 * — the ADR 0102 persisted transcript is the source of truth; this never stores
 * anything. The JSON form is the round-trippable `openwop-v1` export shape the
 * importer (Phase 4) reads.
 *
 * CORRECTED (ADR 0992 D1) — this said "structured message content (interrupt / A2UI
 * cards) renders as a fenced JSON block". The SPA stores EVERY message as a JSON
 * `ChatMessage` envelope, so every message took that branch and the export dumped
 * thoughts, tool calls and interrupt resume tokens — into the public share link
 * too. Rows are now read through {@link messageView}; only a server-written card
 * that is not an envelope is fenced, and secret-named keys are redacted.
 */
import type { ChatSessionRecord, ChatMessageRecord } from '../../types.js';

export const EXPORT_FORMAT_VERSION = 'openwop-v1';

/** ADR 0992 D1 / D7 (H2) — the canonical tombstone a delete or a DSAR erasure
 *  leaves (`routes/chatSessions.ts` tombstone-delete, `redactChatMessagesByAuthor`). */
const TOMBSTONE = '{"deleted":true}';

/** ADR 0992 D1 — keys whose values are never rendered or exported, at any depth
 *  (an interrupt's resume token is a capability; a credential ref names a secret).
 *  Anchored on the key's last word so usage counters (`inputTokens`, `maxTokens`)
 *  survive while `token`, `resumeToken`, `api_key`, `privateKey`… do not. */
const SECRET_KEY = /(^|[_-]|[a-z](?=[A-Z]))(token|secret|password|passphrase|apikey|api_key|authorization|cookie|bearer|privatekey|private_key|signature|sessionkey|session_key)$|credential/i;

/** Deep copy with every {@link SECRET_KEY} value replaced. */
function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(val);
    }
    return out;
  }
  return v;
}

function parseObject(content: string): Record<string, unknown> | unknown[] | null {
  const t = content.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    const p = JSON.parse(t) as unknown;
    return p && typeof p === 'object' ? (p as Record<string, unknown> | unknown[]) : null;
  } catch {
    return null;
  }
}

/** The SPA's persisted `ChatMessage` envelope (`encodeMessageForStore`): an object
 *  with `content` or `role` — the same test `parsePersistedMessages` applies when it
 *  reopens a conversation, so the export reads exactly what the chat showed. */
function isEnvelope(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === 'object' && !Array.isArray(p) && ('content' in p || 'role' in p);
}

/** Text of an envelope's `content`: a string, or `ContentPart[]` (text parts as
 *  text, everything else as a placeholder naming its kind). */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((part) => {
      if (typeof part === 'string') return part;
      const p = (part ?? {}) as { type?: unknown; text?: unknown };
      if (typeof p.text === 'string') return p.text;
      const kind = typeof p.type === 'string' ? p.type.replace(/_url$|_ref$/, '') : 'attachment';
      return `[${kind}]`;
    })
    .filter((s) => s.length > 0)
    .join('\n');
}

/** One stored message as the person saw it (ADR 0992 D1). */
export interface MessageView {
  role: string;
  /** Who said it: the answering agent's persona/id when the row names one, else the role label. */
  speaker: string;
  /** Plain text. Never contains an envelope field other than the message text. */
  text: string;
  /** A server-written structured card (not an SPA envelope), already secret-redacted. */
  card?: string;
  deleted?: true;
}

/** ADR 0992 D1 — THE projection of a stored chat row. Every exit (markdown, the JSON
 *  export's `text`, the share card, the importer) reads rows through this, so none
 *  of them serialises thoughts, tool calls, run state or an interrupt token. */
export function messageView(m: { role: string; content: string; meta: string | null }): MessageView {
  const base = roleLabel(m.role);
  let rowMeta: Record<string, unknown> = {};
  if (m.meta) { try { rowMeta = JSON.parse(m.meta) as Record<string, unknown>; } catch { /* no meta */ } }
  const content = m.content ?? '';
  if (content.trim() === TOMBSTONE || typeof rowMeta.deletedAt === 'string') {
    return { role: m.role, speaker: base, text: '_(message deleted)_', deleted: true };
  }
  const parsed = parseObject(content);
  if (isEnvelope(parsed)) {
    const agent = [parsed.agentPersona, parsed.agentId, rowMeta.agentPersona, rowMeta.agentId]
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return { role: m.role, speaker: m.role === 'assistant' && agent ? agent : base, text: contentText(parsed.content).trim() };
  }
  if (parsed) {
    const redacted = redactSecrets(parsed);
    const same = JSON.stringify(redacted) === JSON.stringify(parsed);
    return { role: m.role, speaker: base, text: '', card: same ? content : JSON.stringify(redacted, null, 2) };
  }
  const agent = [rowMeta.agentPersona, rowMeta.agentId].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return { role: m.role, speaker: m.role === 'assistant' && agent ? agent : base, text: content };
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

/** ADR 0698 D2a (`CXC-5`) — a heading is a single LINE. A title carrying newlines
 *  (or leading `#`) injects arbitrary document structure into the export, and an
 *  imported conversation's title is attacker-supplied. Collapse to one line and
 *  neutralize a leading hash; the title is data, not markup. */
function safeHeadingText(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim().slice(0, 200);
}

/** ADR 0698 D2a (`CXC-5`) — a body containing a literal ``` run CLOSES the fence we
 *  wrap it in, and everything after it renders as document structure rather than as
 *  content. This is the mechanism by which imported content controls the SHAPE of
 *  the exported artifact, not merely its text (see ADR 0698 D3 for why that matters
 *  across the export-as-Document boundary).
 *
 *  Widen the fence instead of escaping the body: pick a backtick run LONGER than any
 *  run the content contains, which is the CommonMark-sanctioned way to embed
 *  backticks and — unlike escaping — leaves the payload byte-identical, so the
 *  `openwop-v1` JSON round trip still reproduces the original exactly. */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Render the transcript as Markdown. Deterministic — message order preserved.
 *  Built only from {@link messageView} (ADR 0992 D1). */
export function transcriptToMarkdown(session: ChatSessionRecord, messages: readonly ChatMessageRecord[]): string {
  const lines: string[] = [];
  lines.push(`# ${safeHeadingText(session.title || '') || 'Conversation'}`);
  lines.push('');
  lines.push(`> Exported from OpenWOP · conversation \`${session.sessionId}\` · ${messages.length} message(s)`);
  lines.push('');
  for (const m of messages) {
    const v = messageView(m);
    lines.push(`## ${safeHeadingText(`${v.speaker} — ${m.createdAt}`)}`);
    lines.push('');
    if (v.card !== undefined) {
      const fence = fenceFor(v.card);
      lines.push(`${fence}json`);
      lines.push(v.card);
      lines.push(fence);
    } else {
      lines.push(v.text);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** The structured `openwop-v1` JSON export (round-trippable by the importer).
 *  ADR 0992 D1 — `content` keeps the stored envelope (the person's own file) with
 *  every secret-named key redacted; `text` + `speaker` are the projection, for any
 *  reader that is not this app. */
export interface TranscriptExport {
  version: typeof EXPORT_FORMAT_VERSION;
  conversation: { sessionId: string; title: string; createdAt: string };
  messages: Array<{ role: string; speaker: string; text: string; content: string; authorSubject: string | null; createdAt: string }>;
}

export function transcriptToJson(session: ChatSessionRecord, messages: readonly ChatMessageRecord[]): TranscriptExport {
  return {
    version: EXPORT_FORMAT_VERSION,
    conversation: { sessionId: session.sessionId, title: session.title, createdAt: session.createdAt },
    messages: messages.map((m) => {
      const v = messageView(m);
      const parsed = parseObject(m.content ?? '');
      const content = parsed && !v.deleted ? redactedContent(m.content, parsed) : (v.deleted ? TOMBSTONE : m.content);
      return { role: m.role, speaker: v.speaker, text: v.text, content, authorSubject: m.authorSubject, createdAt: m.createdAt };
    }),
  };
}

function redactedContent(raw: string, parsed: unknown): string {
  const redacted = redactSecrets(parsed);
  return JSON.stringify(redacted) === JSON.stringify(parsed) ? raw : JSON.stringify(redacted);
}
