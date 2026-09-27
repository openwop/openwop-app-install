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
  `${config.baseUrl}/host/openwop-app/intent-ledger/conversations/${encodeURIComponent(conversationId)}`;
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

// CFP A13 — the bespoke `draftLedgerFromConversation` client (a REST call that hid
// a managed-LLM extractor behind the modal's "Draft from conversation" button) was
// removed. Model-authored drafting now rides the ONE chat: the modal deep-links the
// chat scoped to the Chief of Staff, whose `openwop:intent-ledger.draft-contract`
// tool authors the draft in-conversation for the owner to Approve here.

export async function decideLedger(conversationId: string, decision: 'approve' | 'reject'): Promise<IntentLedger> {
  const res = await fetch(`${base(conversationId)}/${decision}`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return (await asJson<{ ledger: IntentLedger }>(res, 'decideLedger')).ledger;
}

export async function getReckoning(conversationId: string): Promise<LedgerReckoning | null> {
  const res = await fetch(`${base(conversationId)}/reckoning`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ reckoning: LedgerReckoning | null }>(res, 'getReckoning')).reckoning;
}
