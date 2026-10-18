/**
 * ADR 0853 D7 — meeting notes (or any project document) as a decision source.
 * A line that STARTS with `Decision:` (optionally after a list marker), new in
 * this version of a document the PROJECT owns, becomes a SUGGESTION with
 * `source.kind:'meeting'`, linked to the document. The same convention as an
 * inbound `decision:` message (D4): deterministic, no model call. Nothing is
 * recorded until a person does.
 *
 * Why not the meeting-ops templates (the ROADMAP's first idea): they are frozen
 * mock-AI replay archives (maintainer decision 2026-10-10, ADR 0775 P2); a run
 * that DOES report `decisions` is already a source (D6, `runDecisionsSource`).
 *
 * Only lines that were not in the previous version count, so editing the rest
 * of the notes never re-files them; the ref is the document plus the line's
 * hash, so re-adding a line is idempotent too. At most MAX_PER_VERSION per save.
 */
import { createHash } from 'node:crypto';
import type { DocumentVersionAdded } from '../../host/documentVersionObservers.js';
import { getProject } from '../projects/projectsService.js';
import { getLedger } from './ledgerStore.js';
import { createSuggestion } from './suggestions.js';

export const MAX_PER_VERSION = 20;
const DECISION_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*)?decision(?:\*\*)?\s*[:—–-]\s*(?:\*\*)?\s*(.+?)\s*$/i;

/** The decision texts written on `Decision:` lines, normalized (order kept, duplicates dropped). */
export function decisionLines(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = DECISION_LINE.exec(line);
    const text = m?.[1]?.replace(/\*\*$/, '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export async function notesDecisionSource(e: DocumentVersionAdded): Promise<void> {
  if (e.ownerSubject?.kind !== 'project' || e.kind === 'decision-record') return;
  const before = new Set(decisionLines(e.previousContent).map((t) => t.toLowerCase()));
  const fresh = decisionLines(e.content).filter((t) => !before.has(t.toLowerCase())).slice(0, MAX_PER_VERSION);
  if (fresh.length === 0) return;
  const project = await getProject(e.tenantId, e.ownerSubject.id);
  if (!project || !(await getLedger(e.tenantId, project.id))) return;
  for (const text of fresh) {
    const hash = createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16);
    await createSuggestion({
      tenantId: e.tenantId, projectId: project.id,
      title: text.slice(0, 120), text: `${text} (from “${e.title}”)`,
      source: { kind: 'meeting', ref: `${e.documentId}:${hash}`, link: `/documents/${encodeURIComponent(e.documentId)}` },
      suggestedBy: e.producedBy.kind === 'user' ? { kind: 'user', id: e.producedBy.id } : { kind: 'agent', id: e.producedBy.id },
    });
  }
}
