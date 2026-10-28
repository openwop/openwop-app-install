/**
 * ADR 0119 Phase 4b — conversation IMPORT write. ADR 0992 D2–D5 rewrote it.
 *
 * Composes the Phase-4a parsers' normalized `{ title, turns }` into a conversation
 * owned by the importer:
 *
 * - **Only words (D2).** Each turn goes through the export projection
 *   (`messageView`) and is stored as a closed `{ role, content, createdAt }`
 *   envelope. The SPA spreads a stored envelope into a live message, so storing
 *   an imported envelope verbatim let a file render interrupt cards, run cards and
 *   another agent's name. Only `user` and `assistant` turns are stored; system,
 *   workflow, tool, unknown and empty turns are skipped and COUNTED.
 * - **The importer's words (D3).** Every row carries the importer's chat-author
 *   spelling (`host/chatAuthorSubject.ts`, the same stamp the chat append route
 *   writes), so the chat-post DSAR eraser reaches an import.
 * - **Lock before content (D5).** The owned meta is written BEFORE the session row.
 *   An owner-less conversation is tenant-visible (`conversationVisibility.ts`), so
 *   a failure between the two must leave a private conversation, never a public one.
 * - **Idempotent by content (D4).** With an `idempotencyKey`, the id is
 *   `imp-` + sha256(tenant, owner, key, digest of the normalized turns). A repeat
 *   (or a racing twin) finds the same id and only appends the rows a crash left
 *   out. Because the digest is in the id, a reused key with DIFFERENT content
 *   cannot append into an existing conversation (architect B2).
 *
 * PROVENANCE, NOT A FENCE (ADR 0698 D1). Each row keeps
 * `meta: {contentTrust:'untrusted', source:'import'}`. No trust-aware consumer
 * reads a chat row's meta; the SPA reads `source` to label imported messages
 * (ADR 0992 D9).
 *
 * Where imported text CAN reach a model: a turn's history is folded from the
 * conversation run's event log, not from these rows (ADR 0992 D10 / OQ1), so it is
 * never part of the context. But an agent allowlisted for
 * `openwop:conversations.search` can retrieve it. That result is fenced by the
 * TOOL's own `contentTrust:'untrusted'` declaration
 * (`conversation-search/agentTools.ts:22` → `host/toModelToolResult.ts`), not by
 * this row stamp. (code-review CR-1: an earlier draft of this ADR's rewrite said
 * "never reaches a model", which was false.)
 *
 * @see docs/adr/0119-conversation-export-import.md
 * @see docs/adr/0992-chat-export-import-fidelity-and-trust.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { ensureConversationMeta } from '../../host/conversationStore.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { OpenwopError } from '../../types.js';
import type { ImportedConversation } from './importParser.js';
import { messageView } from './transcriptRenderer.js';

export const MAX_TURNS = 2000;
export const MAX_CONTENT = 100_000;
const STORED_ROLES = new Set(['user', 'assistant']);
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface ImportResult {
  sessionId: string;
  /** Turns this import stores (on a replay: the same count, now all present). */
  imported: number;
  /** Turns not stored: roles other than user/assistant, and empty turns. */
  skipped: number;
  /** Turns cut: beyond the turn cap, plus turns whose text was shortened. */
  truncated: number;
  replayed: boolean;
}

interface Row { role: 'user' | 'assistant'; content: string; createdAt: string }

function isPkConflict(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === '23505';
}

function validIso(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** D2 — normalize the parsed turns to the rows that will be stored. Pure. */
export function normalizeTurns(parsed: ImportedConversation, nowMs: number): { rows: Row[]; skipped: number; truncated: number } {
  const rows: Row[] = [];
  let skipped = 0;
  let truncated = Math.max(0, parsed.turns.length - MAX_TURNS);
  for (const t of parsed.turns.slice(0, MAX_TURNS)) {
    if (!STORED_ROLES.has(t.role)) { skipped++; continue; }
    const v = messageView({ role: t.role, content: String(t.content ?? ''), meta: null });
    // An envelope gives its text; a tombstone gives nothing; anything else (plain
    // text, or JSON the person typed) is kept as the person's own words.
    const text = (v.deleted ? '' : v.card !== undefined ? String(t.content) : v.text).trim();
    if (!text) { skipped++; continue; }
    if (text.length > MAX_CONTENT) truncated++;
    // CX2CD-7 — a stamp from the file is kept only if it is not in the future and
    // not before the previous row; otherwise the previous row's time + 1 ms. So a
    // year-9999 stamp cannot sort the import after every later message, and a
    // mixed file stays in order.
    const prevMs = rows.length ? Date.parse(rows[rows.length - 1]!.createdAt) : -Infinity;
    const fileMs = Date.parse(validIso(t.createdAt) ?? '');
    const fallback = Number.isFinite(prevMs) ? prevMs + 1 : nowMs;
    const ms = Number.isFinite(fileMs) && fileMs <= nowMs && fileMs >= prevMs ? fileMs : fallback;
    rows.push({ role: t.role as Row['role'], content: text.slice(0, MAX_CONTENT), createdAt: new Date(ms).toISOString() });
  }
  return { rows, skipped, truncated };
}

export async function importConversation(
  tenantId: string,
  // CXC-1: REQUIRED — an import always yields an OWNED conversation (an owner-less
  // meta is tenant-visible).
  ownerUserId: string,
  parsed: ImportedConversation,
  /** D3 — the importer's chat-author spelling (`chatAuthorSubject(req)`). */
  authorSubject: string,
  /** D4 — optional caller key; absent ⇒ a random id, as before. */
  idempotencyKey?: string,
): Promise<ImportResult> {
  if (!parsed || !Array.isArray(parsed.turns)) {
    throw new OpenwopError('validation_error', 'nothing to import.', 400, {});
  }
  const { rows, skipped, truncated } = normalizeTurns(parsed, Date.now());
  if (rows.length === 0) {
    throw new OpenwopError('validation_error', 'The export holds no messages that can be imported.', 400, { field: 'data', reason: 'empty', skipped });
  }
  const title = (parsed.title || 'Imported conversation').slice(0, 200);
  const storage = hostExtStorage();

  let sessionId: string;
  if (idempotencyKey !== undefined) {
    const digest = createHash('sha256').update(JSON.stringify([title, rows.map((r) => [r.role, r.content])])).digest('hex');
    sessionId = `imp-${createHash('sha256').update([tenantId, ownerUserId, idempotencyKey, digest].join('\u0000')).digest('hex').slice(0, 32)}`;
  } else {
    sessionId = randomUUID();
  }

  // D5 — the lock first. ensureConversationMeta is create-or-return, so on a replay
  // this returns the existing meta, which MUST be the caller's (H3: an erased or
  // foreign owner is a conflict, never a write into someone else's conversation).
  const meta = await ensureConversationMeta(tenantId, sessionId, { type: 'agent', ownerUserId });
  if (!meta.ownerUserId || !subjectKeyForms(ownerUserId).forms.has(meta.ownerUserId)) {
    throw new OpenwopError('conflict', 'This import conflicts with an existing conversation.', 409, { reason: 'import_conflict' });
  }

  let replayed = false;
  const now = new Date().toISOString();
  if (await storage.getChatSession(tenantId, sessionId)) {
    replayed = true;
  } else {
    try {
      await storage.createChatSession({ sessionId, tenantId, title, createdAt: now, updatedAt: now, messageCount: 0 });
    } catch (err) {
      if (!isPkConflict(err)) throw err;
      replayed = true; // H3 — a racing twin created it first
    }
  }

  const existing = replayed ? new Set((await storage.listChatSessionMessages(sessionId)).map((m) => m.messageId)) : new Set<string>();
  const meta0 = JSON.stringify({ contentTrust: 'untrusted', source: 'import' });
  for (let i = 0; i < rows.length; i++) {
    const messageId = `${sessionId}-i${i}`;
    if (existing.has(messageId)) continue;
    const r = rows[i]!;
    try {
      await storage.appendChatMessage({
        messageId, sessionId, role: r.role,
        content: JSON.stringify({ role: r.role, content: r.content, createdAt: r.createdAt }),
        meta: meta0, authorSubject, createdAt: r.createdAt,
      });
    } catch (err) {
      if (!isPkConflict(err)) throw err; // a racing twin wrote this row
    }
  }
  return { sessionId, imported: rows.length, skipped, truncated, replayed };
}
