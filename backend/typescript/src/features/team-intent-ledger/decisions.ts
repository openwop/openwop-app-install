/**
 * ADR 0853 D2 — "Record as decision": a person turns something said (a message,
 * a suggestion, an approval, a drift finding) into a `decision-record` Document
 * in the project's workspace and PROPOSES adding it to the ledger's decisions.
 * The ledger owner may accept it in the same call (the ROADMAP's "within one
 * confirmation step"); anyone else's `accept` only proposes.
 *
 * The record links back to where the decision was made (`provenance.source`).
 * All text is bounded and refused when secret-shaped (never rewritten).
 */
import { OpenwopError } from '../../types.js';
import { cleanOpaqueToken } from '../../host/boundedStrings.js';
import { addVersion, createDocument } from '../documents/documentsService.js';
import type { Project } from '../projects/projectsService.js';
import { acceptDelta, currentState, proposeDelta, strictText, validatePatch } from './ledgerStore.js';
import type { TeamLedger, TeamLedgerDelta } from './types.js';
import { markSuggestionRecorded, requireOpenSuggestion } from './suggestions.js';

export const DECISION_LIMITS = { title: 160, text: 4000, ref: 256, link: 512 } as const;
const SOURCE_KINDS = ['message', 'inbound', 'approval', 'meeting', 'drift'] as const;
type SourceKind = typeof SOURCE_KINDS[number];

export interface DecisionInput { title: string; decision: string; rationale?: string; source?: { kind: SourceKind; ref: string; link?: string }; accept: boolean; suggestionId?: string }

export function parseDecisionInput(raw: unknown): DecisionInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const title = strictText(b.title, DECISION_LIMITS.title, 'title');
  const decision = strictText(b.decision, DECISION_LIMITS.text, 'decision');
  const rationale = b.rationale === undefined || b.rationale === '' ? undefined : strictText(b.rationale, DECISION_LIMITS.text, 'rationale');
  let source: DecisionInput['source'];
  if (b.source !== undefined) {
    const s = (b.source ?? {}) as Record<string, unknown>;
    if (!SOURCE_KINDS.includes(s.kind as SourceKind)) {
      throw new OpenwopError('validation_error', `\`source.kind\` must be one of ${SOURCE_KINDS.join(', ')}.`, 400, { field: 'source.kind' });
    }
    const ref = cleanOpaqueToken(s.ref, DECISION_LIMITS.ref);
    if (!ref) throw new OpenwopError('validation_error', '`source.ref` is required.', 400, { field: 'source.ref' });
    let link: string | undefined;
    if (s.link !== undefined) {
      link = typeof s.link === 'string' ? s.link.trim() : '';
      // A link back is an in-app path or an https URL — never javascript:, data:, or a bare host.
      if (!link || link.length > DECISION_LIMITS.link || !(link.startsWith('/') && !link.startsWith('//') || /^https:\/\//.test(link))) {
        throw new OpenwopError('validation_error', '`source.link` must be an in-app path or an https URL.', 400, { field: 'source.link' });
      }
    }
    source = { kind: s.kind as SourceKind, ref, ...(link ? { link } : {}) };
  }
  const suggestionId = b.suggestionId === undefined ? undefined : cleanOpaqueToken(b.suggestionId, 128);
  if (b.suggestionId !== undefined && !suggestionId) throw new OpenwopError('validation_error', '`suggestionId` is not a valid id.', 400, { field: 'suggestionId' });
  return { title, decision, ...(rationale ? { rationale } : {}), ...(source ? { source } : {}), accept: b.accept === true, ...(suggestionId ? { suggestionId } : {}) };
}

export async function recordDecision(project: Project, ledger: TeamLedger, me: string, input: DecisionInput): Promise<{ documentId: string; delta: TeamLedgerDelta; accepted: boolean; ledger: TeamLedger }> {
  // ADR 0853 D1 — recording FROM a suggestion: it must be open and this project's,
  // checked before anything is written; it is marked recorded afterwards.
  if (input.suggestionId) await requireOpenSuggestion(project.tenantId, project.id, input.suggestionId);
  const markdown = [
    `# Decision: ${input.title}`,
    '',
    `**Project:** ${project.name} (${project.id})`,
    `**Decided:** ${new Date().toISOString().slice(0, 10)} · **Recorded by:** ${me}`,
    ...(input.source ? [`**Made in:** ${input.source.kind}${input.source.link ? ` — ${input.source.link}` : ''}`] : []),
    '',
    '## Decision',
    input.decision,
    ...(input.rationale ? ['', '## Rationale', input.rationale] : []),
  ].join('\n');
  const doc = await createDocument({
    tenantId: project.tenantId, orgId: project.orgId, title: `Decision — ${input.title}`, kind: 'decision-record', format: 'markdown',
    ownerSubject: { kind: 'project', id: project.id },
    provenance: { producedBy: { kind: 'user', id: me }, ...(input.source ? { source: input.source } : {}) },
    createdBy: me,
  });
  await addVersion(project.tenantId, project.orgId, doc.documentId, { content: markdown, producedBy: { kind: 'user', id: me } });
  const state = currentState(ledger, project);
  const patch = await validatePatch({ decisionDocumentIds: [...state.decisionDocumentIds, doc.documentId] }, project);
  const delta = await proposeDelta({
    ledger, patch, why: `Decision recorded: ${input.title}`.slice(0, 500),
    author: { kind: 'user', id: me },
    source: { kind: input.source?.kind ?? 'decision', ref: input.source?.ref ?? doc.documentId },
    baseVersion: ledger.version,
  });
  if (input.suggestionId) await markSuggestionRecorded(project.tenantId, project.id, input.suggestionId, me, doc.documentId);
  if (input.accept && me === ledger.ownerSubject) {
    const out = await acceptDelta(project, delta.deltaId, me);
    return { documentId: doc.documentId, delta: out.delta, accepted: true, ledger: out.ledger };
  }
  return { documentId: doc.documentId, delta, accepted: false, ledger };
}
