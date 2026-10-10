/**
 * ADR 0854 D2 — a channel card when a handoff reaches a PERSON on project work:
 * a card note on the project's board (to its assignee), or a run escalation on a
 * project run (to whoever answers it). ONE short system message in the
 * project's chat and in each channel bound to the project, saying who handed
 * what to whom and why (the note's intent), with a link to the work.
 *
 * Deliberately NOT included: the note's decisions and "tried" text — those stay
 * with the assignee and the work. Agent-to-agent dispatch handoffs post nothing
 * (they do not reach a person). Idempotent on the handoff's ref; only into
 * conversations that already exist (nothing is created to hold a card).
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { HandoffRecorded } from '../../host/handoff/handoffObservers.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { getBoard, getCard } from '../../host/kanbanService.js';
import { postProjectNotice } from '../../host/projectConversations.js';
import { resolveRunProject } from '../../host/runProjectBinding.js';
import { resolveSubjectDisplays } from '../../host/subjectDisplay.js';
import { neutralizeUntrusted } from '../../host/untrustedContent.js';

const posted = new DurableCollection<{ key: string; tenantId: string; at: string }>('structured-handoffs:cards-posted', (r) => r.key, undefined, (r) => r.tenantId);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

async function nameOf(tenantId: string, ref: string | undefined, fallback: string): Promise<string> {
  if (!ref) return fallback;
  const subjectRef = (ref.includes(':') ? ref : `user:${ref}`) as Parameters<typeof resolveSubjectDisplays>[1][number];
  const d = await resolveSubjectDisplays(tenantId, [subjectRef]).catch(() => null);
  return d?.get(subjectRef)?.displayName ?? fallback;
}

export function handoffCardObserver(storage: RouteDeps['storage']) {
  return async (e: HandoffRecorded): Promise<void> => {
    let projectId: string | undefined;
    let text: string;
    let link: string;
    if (e.origin.kind === 'card') {
      const card = await getCard(e.origin.cardId);
      const board = await getBoard(e.origin.boardId);
      if (!card || !board || board.tenantId !== e.tenantId || board.ownerSubject?.kind !== 'project') return;
      projectId = board.ownerSubject.id;
      const by = await nameOf(e.tenantId, e.origin.by, 'Someone');
      const to = card.assigneeId ? await nameOf(e.tenantId, card.assigneeId, 'a teammate') : (card.assigneeRole ? `the ${card.assigneeRole} role` : 'a teammate');
      text = `${by} handed “${neutralizeUntrusted(card.title)}” to ${to}: ${neutralizeUntrusted(e.record.intent)}`;
      link = `/boards/${encodeURIComponent(board.id)}`;
    } else {
      // Only an ESCALATION reaches a person; a dispatch handoff goes agent → agent.
      if (!e.origin.ref.startsWith('interrupt:')) return;
      const run = await storage.getRun(e.origin.runId);
      if (!run || run.tenantId !== e.tenantId) return;
      projectId = await resolveRunProject(e.tenantId, run.metadata ?? {})
        ?? (isObj(run.metadata?.kanban) && typeof run.metadata.kanban.boardId === 'string'
          ? await getBoard(run.metadata.kanban.boardId).then((b) => (b?.ownerSubject?.kind === 'project' ? b.ownerSubject.id : undefined))
          : undefined);
      if (!projectId) return;
      text = `A run needs a person to decide: ${neutralizeUntrusted(e.record.intent)}`;
      link = `/runs/${encodeURIComponent(run.runId)}`;
    }
    const key = `${e.tenantId}:${e.origin.ref}`;
    if (!(await posted.putIfAbsent({ key, tenantId: e.tenantId, at: new Date().toISOString() }))) return;
    await postProjectNotice(e.tenantId, projectId, text, { source: 'handoff-card', link });
  };
}
