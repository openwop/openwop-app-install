/**
 * ADR 0853 D4 — an inbound `decision:` message (Slack / Discord / Telegram /
 * WhatsApp) on a project-linked connection becomes a SUGGESTION on that
 * project's ledger. The text is untrusted and stays a suggestion until a person
 * records it. Idempotent on the provider's message ref.
 */
import type { InboundMessage } from '../../host/inboundMessageObservers.js';
import { getProject } from '../projects/projectsService.js';
import { getLedger } from './ledgerStore.js';
import { createSuggestion } from './suggestions.js';

export async function inboundDecisionSource(m: InboundMessage): Promise<void> {
  const project = await getProject(m.tenantId, m.projectId);
  if (!project || !(await getLedger(m.tenantId, project.id))) return;
  const body = m.text.replace(/^\s*decision:\s*/i, '').trim();
  if (!body) return;
  const first = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? body;
  await createSuggestion({
    tenantId: m.tenantId, projectId: project.id,
    title: first.length > 80 ? `${first.slice(0, 79)}…` : first,
    text: body,
    source: { kind: 'inbound', ref: `${m.connectionId}:${m.ref}` },
    suggestedBy: { kind: 'host', id: m.provider },
  });
}
