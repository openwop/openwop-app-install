/**
 * Agent Author draft-stash client (ADR 0514 OQ1) — the wizard's side of the
 * describe-to-create hand-off. The stash is the caller's OWN row; the backend
 * scopes by session subject.
 *
 * Failure posture: the stash is an ENRICHMENT (a prefill offer), so a failed
 * read returns null and the wizard simply makes no offer — silence about
 * enrichment, with NO textual claim that no draft exists (the alignment-strip
 * tier of the failed-read doctrine, recorded in the tracker).
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface StashedDraft {
  persona: string;
  agentId: string;
  label?: string;
  description?: string;
  roleKey?: string;
  autonomyLevel?: 'auto' | 'guided' | 'review';
  workflows?: string[];
}

const URL_ = (): string => `${config.baseUrl}/host/openwop-app/agent-author/draft`;

export async function getStashedAgentDraft(): Promise<{ draft: StashedDraft; stashedAt?: string } | null> {
  try {
    const res = await fetch(URL_(), fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return null;
    const body = (await res.json()) as { draft?: StashedDraft | null; stashedAt?: string };
    return body.draft ? { draft: body.draft, ...(body.stashedAt ? { stashedAt: body.stashedAt } : {}) } : null;
  } catch {
    return null; // enrichment: no offer, no claim
  }
}

export async function dismissStashedAgentDraft(): Promise<void> {
  try {
    await fetch(URL_(), fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  } catch {
    // Best-effort: a failed dismiss leaves the stash for next time — the offer
    // reappears, which is annoying but honest; never block the wizard on it.
  }
}
