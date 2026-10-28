/**
 * Conversation & message search (ADR 0112, rebuilt by ADR 0997).
 *
 * Search reads the durable chat store at request time. It keeps NO copy of message
 * text anywhere. ADR 0112 Phase 1 built a derived index on the tenant's `db.search`
 * host surface; ADR 0997 removed it because every defect found in it was a way the
 * copy disagreed with the source:
 * - the surface is durable in prod, while the ids to clean up lived in process
 *   memory, so deleted and DSAR-erased text came back after a restart (CSP-1/2);
 * - every workflow run in the tenant gets the same surface, so
 *   `core.db.search-query` could read other members' private messages (CSP-3);
 * - the query ranked the tenant-wide index and filtered afterwards, so other
 *   members' matches crowded the caller's out (CSP-4).
 *
 * Now the caller's visible conversation ids (ADR 0043 predicate) go to
 * `Storage.searchChatMessages`, a database prefilter. Each candidate row is then
 * read through `messageView` (ADR 0992 D1), the one projection every chat exit
 * uses, and only the text the person saw can match or be shown (CSP-5).
 *
 * Replay/fork: N/A, read-only, nothing recorded or stamped.
 */
import type { Storage } from '../../storage/storage.js';
import { listConversationMetas, type ConversationType } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { createLogger } from '../../observability/logger.js';
import { messageView } from '../chat-export/transcriptRenderer.js';
import { purgeLegacySearchIndexOnce } from './legacyIndexPurge.js';

const log = createLogger('conversation-search');

/** ADR 0997 D3 — candidate rows read per query. Reaching it sets `truncated`. */
export const CANDIDATE_LIMIT = 500;
/** ADR 0997 D3 — query bounds. */
const MAX_QUERY_CHARS = 200;
const MAX_TOKENS = 8;
const DEFAULT_LIMIT = 20;

export interface SearchScope {
  tenantId: string;
  /** The caller's readable conversation ids, resolved through the ADR 0043
   *  predicate BEFORE the query. The ONLY conversations a hit may come from. */
  visibleConversationIds: readonly string[];
  /** Live titles, matched as-is (no stale copy). */
  titleById?: ReadonlyMap<string, string>;
  /** Live conversation types, for the `type` facet and hit enrichment. */
  typeById?: ReadonlyMap<string, ConversationType>;
  /** Optional facet: only conversations of this type. */
  type?: ConversationType;
  /** Optional facet: only messages authored in this role. */
  role?: string;
  /** Max conversations returned (default 20). */
  limit?: number;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  type?: ConversationType;
  /** The best-matching message (absent ⇒ a title-only hit). */
  messageId?: string;
  /** Excerpt around the match (or the title for a title-only hit). */
  snippet: string;
  score: number;
  /** The matched message's `createdAt`. */
  matchedAt?: string;
  /** The matched message's role. */
  role?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when the candidate cap was reached: only the newest
   *  {@link CANDIDATE_LIMIT} matching messages were examined. */
  truncated: boolean;
}

/** ADR 0997 D3 — Unicode letter/number runs, lower-cased, de-duplicated, at most
 *  {@link MAX_TOKENS}. The old ASCII split broke `café` into `caf`. */
export function queryTokens(q: string): string[] {
  const runs = q.slice(0, MAX_QUERY_CHARS).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(runs)].slice(0, MAX_TOKENS);
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** ALL tokens must occur; the score sums `1 + ln(1 + occurrences)` per token.
 *  Null when any token is missing. */
function scoreText(text: string, tokens: readonly string[]): number | null {
  const lower = text.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    const n = occurrences(lower, tok);
    if (n === 0) return null;
    score += 1 + Math.log(1 + n);
  }
  return score;
}

const HIGHLIGHT_RADIUS = 60;

/** An excerpt around the earliest token occurrence. */
function snippetFor(text: string, tokens: readonly string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, HIGHLIGHT_RADIUS * 2).trim();
  const start = Math.max(0, at - HIGHLIGHT_RADIUS);
  const end = Math.min(text.length, at + HIGHLIGHT_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** XCH-HOLE-5: the ONE owner of "search the caller's visible conversations". The
 *  route and the `openwop:conversations.search` agent tool both call THIS, so the
 *  ADR 0043 visibility filter cannot drift between them. Visibility is resolved
 *  BEFORE the query; only those ids reach storage. */
export async function searchVisibleConversations(
  storage: Storage,
  tenantId: string,
  actingUserId: string | undefined,
  q: string,
  opts?: { type?: ConversationType; role?: string; limit?: number },
): Promise<SearchResult> {
  if (queryTokens(q).length === 0) return { hits: [], truncated: false };
  await purgeLegacySearchIndexOnce(); // ADR 0997 D6 — once per process, best-effort
  const [sessions, metas] = await Promise.all([
    storage.listChatSessions(tenantId),
    listConversationMetas(tenantId),
  ]);
  const byId = new Map(metas.map((m) => [m.conversationId, m]));
  const shown = await Promise.all(
    sessions.map((s) => isVisibleToAsync(byId.get(s.sessionId) ?? null, tenantId, actingUserId)),
  );
  const visibleSessions = sessions.filter((_, i) => shown[i]);
  return searchConversations(storage, {
    tenantId,
    visibleConversationIds: visibleSessions.map((s) => s.sessionId),
    titleById: new Map(visibleSessions.map((s) => [s.sessionId, s.title])),
    typeById: new Map(visibleSessions.map((s) => [s.sessionId, byId.get(s.sessionId)?.type ?? 'agent'])),
    ...(opts?.type ? { type: opts.type } : {}),
    ...(opts?.role ? { role: opts.role } : {}),
    limit: opts?.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT,
  }, q);
}

export async function searchConversations(
  storage: Storage,
  scope: SearchScope,
  q: string,
): Promise<SearchResult> {
  const started = Date.now();
  const tokens = queryTokens(q);
  if (tokens.length === 0) return { hits: [], truncated: false };
  const limit = scope.limit && scope.limit > 0 ? scope.limit : DEFAULT_LIMIT;
  const visible = scope.visibleConversationIds.filter((id) => !scope.type || scope.typeById?.get(id) === scope.type);
  if (visible.length === 0) return { hits: [], truncated: false };
  const visibleSet = new Set(visible);

  const rows = await storage.searchChatMessages(visible, tokens, { limit: CANDIDATE_LIMIT });
  const truncated = rows.length >= CANDIDATE_LIMIT;

  const bestByConv = new Map<string, SearchHit>();
  for (const row of rows) {
    if (!visibleSet.has(row.sessionId)) continue; // the storage contract, re-asserted
    if (scope.role && row.role !== scope.role) continue;
    // ADR 0997 D1 / ADR 0992 D1 — the database matched the RAW envelope; only the
    // text the person saw decides a hit. A deleted row or a card has no text.
    const view = messageView(row);
    if (view.deleted || !view.text) continue;
    const score = scoreText(view.text, tokens);
    if (score === null) continue;
    const prev = bestByConv.get(row.sessionId);
    // Rows arrive newest first, so a tie keeps the newer message.
    if (prev && prev.score >= score) continue;
    const type = scope.typeById?.get(row.sessionId);
    bestByConv.set(row.sessionId, {
      conversationId: row.sessionId,
      title: scope.titleById?.get(row.sessionId) ?? '',
      ...(type ? { type } : {}),
      messageId: row.messageId,
      snippet: snippetFor(view.text, tokens),
      score,
      matchedAt: row.createdAt,
      role: row.role,
    });
  }

  // Live title hits: add a conversation with no message hit. The role facet
  // excludes them (a title has no author).
  if (!scope.role && scope.titleById) {
    for (const id of visible) {
      if (bestByConv.has(id)) continue;
      const title = scope.titleById.get(id);
      if (!title || scoreText(title, tokens) === null) continue;
      const type = scope.typeById?.get(id);
      bestByConv.set(id, { conversationId: id, title, ...(type ? { type } : {}), snippet: title, score: 1 });
    }
  }

  const hits = [...bestByConv.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  // ADR 0997 D7 — counts only, never the query or any text.
  log.info('conversation_search', {
    visible: visible.length, candidates: rows.length, hits: hits.length, truncated, ms: Date.now() - started,
  });
  return { hits, truncated };
}
