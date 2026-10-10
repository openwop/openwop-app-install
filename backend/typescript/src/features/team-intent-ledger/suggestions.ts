/**
 * ADR 0853 D1 — decision SUGGESTIONS: the one place automatic sources (the
 * suggester, inbound messages, resolved approvals, meeting notes, drift
 * findings) put what MIGHT be a decision. A suggestion never changes the ledger:
 * a person either Records it (ADR 0853 D2, which marks it recorded) or Dismisses
 * it.
 *
 * Bounded and redacted at write; idempotent on (project, source kind, source
 * ref) so a retried or replayed source does not suggest twice; at most
 * `SUGGESTION_LIMITS.open` open per project (a looping source cannot flood the
 * owner — the excess is refused and logged, not queued).
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { scrubSecretShaped } from '../../host/redactSecrets.js';
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';

const log = createLogger('feature.team-intent-ledger.suggestions');

export const SUGGESTION_LIMITS = { open: 50, title: 160, text: 1000, ref: 256, link: 512, reason: 500 } as const;
export type SuggestionSourceKind = 'message' | 'inbound' | 'approval' | 'meeting' | 'drift';

export interface DecisionSuggestion {
  suggestionId: string;
  tenantId: string;
  projectId: string;
  title: string;
  text: string;
  source: { kind: SuggestionSourceKind; ref: string; link?: string };
  suggestedBy: { kind: 'agent' | 'host' | 'user'; id: string };
  /** `sent-back` (ADR 0855 D2): a drift finding returned to whoever started the run. */
  status: 'open' | 'recorded' | 'dismissed' | 'sent-back';
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  documentId?: string;
  /** Why it was dismissed or what to change (ADR 0855 D2: a dismissal records who and why). */
  reason?: string;
}

declarePiiFields('teamLedger.suggestion', ['text', 'title', 'reason']);

const rows = new DurableCollection<DecisionSuggestion>('team-ledger:suggestions', (s) => s.suggestionId, undefined, (s) => s.tenantId);

const nowIso = (): string => new Date().toISOString();
const bound = (s: string, max: number): string => {
  const t = scrubSecretShaped(s.trim().replace(/\s+\n/g, '\n'));
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export async function listSuggestions(tenantId: string, projectId: string, status: DecisionSuggestion['status'] = 'open'): Promise<DecisionSuggestion[]> {
  return (await rows.listForTenantIndexed(tenantId))
    .filter((s) => s.tenantId === tenantId && s.projectId === projectId && s.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSuggestion(tenantId: string, suggestionId: string): Promise<DecisionSuggestion | null> {
  const s = await rows.get(suggestionId);
  return s && s.tenantId === tenantId ? s : null;
}

/** Create a suggestion, or return the existing one for the same source. Null when the project's queue is full. */
export async function createSuggestion(input: {
  tenantId: string; projectId: string; title: string; text: string;
  source: DecisionSuggestion['source']; suggestedBy: DecisionSuggestion['suggestedBy'];
}): Promise<DecisionSuggestion | null> {
  const all = (await rows.listForTenantIndexed(input.tenantId)).filter((s) => s.tenantId === input.tenantId && s.projectId === input.projectId);
  const ref = input.source.ref.slice(0, SUGGESTION_LIMITS.ref);
  const same = all.find((s) => s.source.kind === input.source.kind && s.source.ref === ref);
  if (same) return same;
  if (all.filter((s) => s.status === 'open').length >= SUGGESTION_LIMITS.open) {
    log.info('decision_suggestion_queue_full', { tenantId: input.tenantId, projectId: input.projectId, source: input.source.kind });
    return null;
  }
  const title = bound(input.title, SUGGESTION_LIMITS.title);
  const text = bound(input.text, SUGGESTION_LIMITS.text);
  if (!title || !text) return null;
  const link = input.source.link && input.source.link.length <= SUGGESTION_LIMITS.link
    && ((input.source.link.startsWith('/') && !input.source.link.startsWith('//')) || /^https:\/\//.test(input.source.link)) ? input.source.link : undefined;
  const s: DecisionSuggestion = {
    suggestionId: `tls_${randomUUID()}`, tenantId: input.tenantId, projectId: input.projectId, title, text,
    source: { kind: input.source.kind, ref, ...(link ? { link } : {}) },
    suggestedBy: input.suggestedBy, status: 'open', createdAt: nowIso(),
  };
  await rows.put(s);
  return s;
}

/** Close an OPEN suggestion of THIS project; a missing, foreign or closed one is a 404. */
async function close(tenantId: string, projectId: string, suggestionId: string, by: string, status: Exclude<DecisionSuggestion['status'], 'open'>, documentId?: string, reason?: string): Promise<DecisionSuggestion> {
  const s = await getSuggestion(tenantId, suggestionId);
  if (!s || s.projectId !== projectId || s.status !== 'open') {
    throw new OpenwopError('not_found', 'No open suggestion with that id on this project.', 404, { suggestionId });
  }
  const why = reason ? bound(reason, SUGGESTION_LIMITS.reason) : '';
  const next: DecisionSuggestion = { ...s, status, decidedBy: by, decidedAt: nowIso(), ...(documentId ? { documentId } : {}), ...(why ? { reason: why } : {}) };
  await rows.put(next);
  return next;
}
export const dismissSuggestion = (tenantId: string, projectId: string, suggestionId: string, by: string, reason?: string): Promise<DecisionSuggestion> =>
  close(tenantId, projectId, suggestionId, by, 'dismissed', undefined, reason);
export const markSuggestionSentBack = (tenantId: string, projectId: string, suggestionId: string, by: string, reason: string): Promise<DecisionSuggestion> =>
  close(tenantId, projectId, suggestionId, by, 'sent-back', undefined, reason);
export const markSuggestionRecorded = (tenantId: string, projectId: string, suggestionId: string, by: string, documentId: string): Promise<DecisionSuggestion> =>
  close(tenantId, projectId, suggestionId, by, 'recorded', documentId);

/** Asserts an OPEN suggestion of this project exists (before a record writes anything). */
export async function requireOpenSuggestion(tenantId: string, projectId: string, suggestionId: string): Promise<DecisionSuggestion> {
  const s = await getSuggestion(tenantId, suggestionId);
  if (!s || s.projectId !== projectId || s.status !== 'open') {
    throw new OpenwopError('not_found', 'No open suggestion with that id on this project.', 404, { suggestionId });
  }
  return s;
}

/** DSAR: a person's suggestion text (when a person suggested it), and their decider identity + reason. */
export async function eraseSuggestionSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const s of await rows.listForTenantIndexed(tenantId)) {
    if (s.tenantId !== tenantId) continue;
    const suggested = s.suggestedBy.kind === 'user' && forms.has(s.suggestedBy.id);
    const decided = s.decidedBy !== undefined && forms.has(s.decidedBy);
    if (!suggested && !decided) continue;
    await rows.put({
      ...s,
      ...(suggested ? { suggestedBy: { kind: 'user' as const, id: ERASED }, text: ERASED, title: ERASED } : {}),
      ...(decided ? { decidedBy: ERASED, ...(s.reason ? { reason: ERASED } : {}) } : {}),
    });
  }
}
export function registerSuggestionErasure(): void { registerSubjectEraser(eraseSuggestionSubject); }

/** ADR 0839 D2 — the project-delete cascade. */
export async function countSuggestionsForProject(tenantId: string, projectId: string): Promise<number> {
  return (await rows.listForTenantIndexed(tenantId)).filter((s) => s.tenantId === tenantId && s.projectId === projectId).length;
}
export async function deleteSuggestionsForProject(tenantId: string, projectId: string): Promise<number> {
  let n = 0;
  for (const s of await rows.listForTenantIndexed(tenantId)) {
    if (s.tenantId === tenantId && s.projectId === projectId && (await rows.delete(s.suggestionId))) n += 1;
  }
  return n;
}
