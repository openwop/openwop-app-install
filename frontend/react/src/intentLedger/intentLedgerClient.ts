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
  approvedAt?: string;
  /** ADR 0896 D1 — bumped by every write; a decision names the revision it reviewed. */
  revision: number;
  /** ADR 0896 D1 — the server's digest of the contract shown; a decision echoes it. */
  digest: string;
  createdAt: string;
}

/** ADR 0896 D2 — what THIS viewer may do, from the predicates the writes enforce. */
export interface MissionViewer { mayEdit: boolean; mayDecide: boolean }
export interface MissionView { ledger: IntentLedger | null; viewer: MissionViewer }

/** ADR 0896 D1 — the mission changed between the read and the decision (409
 *  `ledger_changed`): the caller must show the new version before deciding again. */
export class LedgerChangedError extends Error {}
/** IL2UX-1 — the conversation is not visible to this caller, or not saved yet (404). */
export class MissionNotFoundError extends Error {}

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
    let reason: unknown;
    try {
      const body = (await res.json()) as { message?: string; details?: { reason?: unknown } };
      detail = body?.message ?? '';
      reason = body?.details?.reason;
    } catch { /* non-JSON */ }
    if (res.status === 409 && reason === 'ledger_changed') throw new LedgerChangedError(detail);
    if (res.status === 404) throw new MissionNotFoundError(detail);
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getLedger(conversationId: string): Promise<MissionView> {
  const res = await fetch(base(conversationId), fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ ledger: IntentLedger | null; viewer?: MissionViewer }>(res, 'getLedger');
  return { ledger: body.ledger, viewer: body.viewer ?? { mayEdit: false, mayDecide: false } };
}

/** ADR 0856 D2 — what a new draft in a project's conversation starts from: the team
 *  ledger's goal + scope (untrusted text, shown as data) and the restrictions the
 *  draft keeps (the server pre-fills them and refuses a draft that drops one). */
export interface MissionPrefill {
  goal?: string;
  forbidden: string[];
  requireApproval: string[];
  sources: { kind: 'project'; id: string; name: string; inScope: string[]; outOfScope: string[] }[];
}

export async function getPrefill(conversationId: string): Promise<MissionPrefill | null> {
  const res = await fetch(`${base(conversationId)}/prefill`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ prefill: MissionPrefill | null }>(res, 'getPrefill')).prefill;
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

/** ADR 0896 D1 — approve what you saw: the decision names the version rendered. */
export async function decideLedger(conversationId: string, decision: 'approve' | 'reject', reviewed: Pick<IntentLedger, 'ledgerId' | 'revision' | 'digest'>): Promise<IntentLedger> {
  const res = await fetch(`${base(conversationId)}/${decision}`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ledgerId: reviewed.ledgerId, revision: reviewed.revision, digest: reviewed.digest }) }));
  return (await asJson<{ ledger: IntentLedger }>(res, 'decideLedger')).ledger;
}

export async function getReckoning(conversationId: string): Promise<LedgerReckoning | null> {
  const res = await fetch(`${base(conversationId)}/reckoning`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ reckoning: LedgerReckoning | null }>(res, 'getReckoning')).reckoning;
}
