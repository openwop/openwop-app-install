/**
 * ADR 0136 Phase 5 — client for the per-conversation intent ledger + reckoning.
 * Backend is authority (toggle + owner/visibility); a 404 means the feature is off
 * or the conversation isn't visible.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface IntentLedger {
  ledgerId: string;
  tenantId: string;
  conversationId: string;
  goal: string;
  allowed: string[];
  forbidden: string[];
  requireApproval: string[];
  successCriteria: string[];
  expiresAtRelMs?: number;
  status: 'draft' | 'approved' | 'expired' | 'rejected';
  proposedBy: 'extractor' | 'user';
  approvedBy?: string;
  createdAt: string;
}

export interface LedgerReckoning {
  goal: string;
  successCriteria: { text: string; status: 'needs-review' }[];
  authorizedTools: string[];
  gatedTools: string[];
  usedTools: string[];
  blockedToolAttempts: string[];
  withinMandate: boolean;
}

const base = (conversationId: string): string =>
  `${config.baseUrl}/v1/host/openwop-app/intent-ledger/conversations/${encodeURIComponent(conversationId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getLedger(conversationId: string): Promise<IntentLedger | null> {
  const res = await fetch(base(conversationId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ ledger: IntentLedger | null }>(res, 'getLedger')).ledger;
}

export interface DraftInput { goal: string; allowed?: string[]; forbidden?: string[]; requireApproval?: string[]; successCriteria?: string[]; expiresAtRelMs?: number }

export async function draftLedger(conversationId: string, input: DraftInput): Promise<IntentLedger> {
  const res = await fetch(`${base(conversationId)}/draft`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ ledger: IntentLedger }>(res, 'draftLedger')).ledger;
}

/** Auto-draft from the conversation's last user message (the LLM extractor, gated by the
 *  server-side complexity guard — a trivial request 422s). */
export async function draftLedgerFromConversation(conversationId: string, lastUserMessage: string): Promise<IntentLedger> {
  const res = await fetch(`${base(conversationId)}/draft`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ lastUserMessage }) }));
  return (await asJson<{ ledger: IntentLedger }>(res, 'draftLedgerFromConversation')).ledger;
}

export async function decideLedger(conversationId: string, decision: 'approve' | 'reject'): Promise<IntentLedger> {
  const res = await fetch(`${base(conversationId)}/${decision}`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return (await asJson<{ ledger: IntentLedger }>(res, 'decideLedger')).ledger;
}

export async function getReckoning(conversationId: string): Promise<LedgerReckoning | null> {
  const res = await fetch(`${base(conversationId)}/reckoning`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ reckoning: LedgerReckoning | null }>(res, 'getReckoning')).reckoning;
}
