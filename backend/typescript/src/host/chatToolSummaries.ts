/**
 * ADR 1040 D7 F3 (Book AI P47) — a per-call DISPLAY summary for a chat tool
 * call ("Read chapter 3 (2,140 words)"), shown on the turn receipt's tool row.
 *
 * HOST-ONLY, by decision. The receipt's rows come from the wire
 * (`agent.toolCalled` / `agent.toolReturned`, RFC 0064), and `agentToolReturned`
 * is closed; its `outcome` is the tool RESULT slot, which this host deliberately
 * never fills (the result reaches the model through compaction). A display line
 * must not ride there, so it travels its own host channel instead:
 *
 *  - a tool MAY return `display: { summary }` beside `content`;
 *  - the chat transport (`conversationToolLoop`) records it here and strips it
 *    from the result BEFORE the loop sees it, so it is never model text, never
 *    compacted, never in a replay digest;
 *  - it is sanitized to plain text with a host cap, and the UI renders text;
 *  - `GET /host/openwop-app/chat/tool-summaries` serves one turn's rows, gated
 *    by `canReadChatTurn` (artifactProjection.ts): the SAME predicate a chat
 *    turn's artifacts are read under, failing EMPTY for anyone else.
 *
 * Keyed (tenant, conversationRunId, turnMessageId, callId): a conversation run
 * spans many turns, and some providers restart call ids every response
 * (`gemini-<name>-<n>`), so a key without the turn would let a later turn
 * overwrite an earlier one's row. A second, conversation-keyed index makes
 * the conversation-delete cascade a prefix delete instead of a tenant scan.
 *
 * Lifecycle: deleted with its conversation (the chat delete cascade), erased
 * with its acting user (DSAR), and aged out (`registerKvAgeOut`, TTL).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import { registerRetentionPurger, purgeRowsByAge } from './retentionPurger.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { canReadChatTurn, chatTurnScope } from './artifactProjection.js';
import type { ExecuteAgentTool } from './agentDispatch.js';

/** C0/C1 controls, invisible formatting (zero-width space, word joiners, BOM),
 *  line/paragraph separators, bidi EMBEDDINGS/OVERRIDES/ISOLATES and tag
 *  characters (invisible-text smuggling). LRM/RLM, ZWJ and ZWNJ are KEPT: RTL
 *  text and joined emoji need them, and they cannot reorder a line. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
/** Read no more than this much raw input (the tag strip is linear only on a bounded input). */
const RAW_MAX_CHARS = 4096;

/** The longest summary a row keeps, in characters. */
export const TOOL_SUMMARY_MAX_CHARS = 160;
/** How long a summary is kept: long enough for any visible thread, then gone. */
const TTL_DAYS = 90;

export interface ToolSummaryRow {
  tenantId: string;
  conversationRunId: string;
  callId: string;
  /** The chat session the run belongs to (for the conversation-delete cascade). */
  conversationId?: string;
  turnMessageId: string;
  toolName: string;
  summary: string;
  /** Who the tools acted for (for DSAR erasure). */
  actingUserId?: string;
  createdAt: string;
}

const COLLECTION = 'chat:tool-summary';
const keyOf = (r: Pick<ToolSummaryRow, 'tenantId' | 'conversationRunId' | 'turnMessageId' | 'callId'>): string =>
  `${r.tenantId}:${r.conversationRunId}:${r.turnMessageId}:${r.callId}`;
// Literal names: the ADR 0464 coverage tripwire reads DurableCollection literals.
const rows = new DurableCollection<ToolSummaryRow>('chat:tool-summary', keyOf);
/** The conversation-keyed index: `${tenant}:${conversationId}:${primary key}`. */
interface ToolSummaryIndexRow { tenantId: string; conversationId: string; key: string; createdAt: string }
const byConversation = new DurableCollection<ToolSummaryIndexRow>('chat:tool-summary-conv', (r) => `${r.tenantId}:${r.conversationId}:${r.key}`);

/**
 * Plain text, capped: no markup, no control characters, whitespace collapsed.
 * Returns undefined for anything that is not a non-empty string afterwards.
 */
export function sanitizeToolSummary(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw
    .slice(0, RAW_MAX_CHARS)
    .replace(/<[^<>]*>/g, ' ')           // tags (a lone `<` or `>` is just text, rendered as text)
    .replace(INVISIBLE, ' ')             // controls, invisible formatting, bidi overrides, tag chars
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  // Counted and cut in code points, so a surrogate pair is never split.
  const chars = Array.from(text);
  return chars.length > TOOL_SUMMARY_MAX_CHARS ? `${chars.slice(0, TOOL_SUMMARY_MAX_CHARS - 1).join('').trimEnd()}…` : text;
}

/** Record one call's summary (best-effort; a failure never touches the turn). */
export async function recordToolSummary(input: {
  tenantId: string; conversationRunId: string; callId: string; turnMessageId: string;
  toolName: string; summary: unknown; conversationId?: string | undefined; actingUserId?: string | undefined;
}): Promise<boolean> {
  const summary = sanitizeToolSummary(input.summary);
  if (!summary || !input.tenantId || !input.conversationRunId || !input.callId || !input.turnMessageId) return false;
  const row: ToolSummaryRow = {
    tenantId: input.tenantId,
    conversationRunId: input.conversationRunId,
    callId: input.callId,
    turnMessageId: input.turnMessageId,
    toolName: input.toolName,
    summary,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.actingUserId ? { actingUserId: input.actingUserId } : {}),
    createdAt: new Date().toISOString(),
  };
  await rows.put(row);
  if (row.conversationId) await byConversation.put({ tenantId: row.tenantId, conversationId: row.conversationId, key: keyOf(row), createdAt: row.createdAt });
  return true;
}

/**
 * Wrap a chat turn's tool executor: a result's `display` is recorded here and
 * REMOVED from what is returned, so nothing downstream (eval capture, the tool
 * loop, the model, compaction, replay) ever sees it. A failed call records
 * nothing. Display-only: a failed write never touches the turn.
 */
export function withToolSummaryChannel(
  exec: ExecuteAgentTool,
  ctx: { tenantId: string; conversationRunId: string; turnMessageId?: string; conversationId?: string; actingUserId?: string },
): ExecuteAgentTool {
  return async (call) => {
    const out = await exec(call);
    if (!out.display) return out;
    const { display, ...rest } = out;
    if (!out.isError && call.callId && ctx.turnMessageId) {
      try {
        await recordToolSummary({ ...ctx, turnMessageId: ctx.turnMessageId, callId: call.callId, toolName: call.name, summary: display.summary });
      } catch { /* display-only */ }
    }
    return rest;
  };
}

/**
 * One turn's summaries, for a caller who may READ that conversation. Empty for
 * anyone else (an unknown run, another tenant's run, a run with no chat
 * session, or a conversation the caller cannot see) — no existence signal.
 */
export async function listToolSummariesForTurn(
  tenantId: string,
  subject: string | undefined,
  conversationRunId: string,
  turnMessageId: string,
  ctx: { personalTenant?: string | undefined } = {},
): Promise<Array<{ callId: string; toolName: string; summary: string }>> {
  if (!subject) return [];
  const scope = await chatTurnScope(tenantId, conversationRunId);
  if (!scope?.conversationId) return [];
  if (!(await canReadChatTurn(tenantId, subject, scope, ctx).catch(() => false))) return [];
  return (await rows.listByPrefix(`${tenantId}:${conversationRunId}:${turnMessageId}:`))
    .filter((r) => r.tenantId === tenantId && r.conversationRunId === conversationRunId && r.turnMessageId === turnMessageId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({ callId: r.callId, toolName: r.toolName, summary: r.summary }));
}

/** Delete every summary of a deleted conversation: a prefix read of the
 *  conversation index, never a tenant scan. Direct call from the chat delete
 *  cascade (`conversationCascade.ts`), like the other host-owned sidecars. */
export async function deleteToolSummariesForConversation(tenantId: string, conversationId: string): Promise<number> {
  let n = 0;
  for (const ix of await byConversation.listByPrefix(`${tenantId}:${conversationId}:`)) {
    if (ix.tenantId !== tenantId || ix.conversationId !== conversationId) continue;
    await rows.delete(ix.key);
    await byConversation.delete(`${ix.tenantId}:${ix.conversationId}:${ix.key}`);
    n += 1;
  }
  return n;
}

async function deleteRow(r: ToolSummaryRow): Promise<void> {
  await rows.delete(keyOf(r));
  if (r.conversationId) await byConversation.delete(`${r.tenantId}:${r.conversationId}:${keyOf(r)}`);
}

/** DSAR — drop every summary written for this subject's turns. */
export async function eraseSubjectToolSummaries(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await rows.listByPrefix(`${tenantId}:`)) {
    if (r.tenantId === tenantId && r.actingUserId && forms.has(r.actingUserId)) await deleteRow(r);
  }
}

/** Register the DSAR eraser (idempotent). Called from `host/hostSubjectErasers.ts`. */
export function registerToolSummaryErasure(): void {
  registerSubjectEraser(eraseSubjectToolSummaries);
}

registerKvAgeOut({ id: COLLECTION, prefix: `hostext:${COLLECTION}:`, ttlDays: TTL_DAYS, timestampField: 'createdAt' });
registerKvAgeOut({ id: 'chat:tool-summary-conv', prefix: 'hostext:chat:tool-summary-conv:', ttlDays: TTL_DAYS, timestampField: 'createdAt' });
// A summary can echo what a tool read (a chapter title, a customer's name), so
// it is retained like the conversation it describes.
registerRetentionPurger({
  feature: COLLECTION,
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const all = await rows.listByPrefix(`${tenantId}:`);
    const byKey = new Map(all.map((r) => [keyOf(r), r]));
    return purgeRowsByAge(COLLECTION, all, tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.createdAt, id: keyOf(r) }),
      (id) => { const r = byKey.get(id); return r ? deleteRow(r) : rows.delete(id); });
  },
});
