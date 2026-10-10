/**
 * ADR 0831 — team intent ledger client (`/host/openwop-app/team-ledger/projects/:id`).
 * The ledger versions the project charter's goal/objectives and adds scope, open
 * questions and decision references. Changes are proposed, and the owner accepts.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface LedgerState {
  goal?: string;
  objectives: string[];
  openQuestions: string[];
  inScope: string[];
  outOfScope: string[];
  decisionDocumentIds: string[];
  /** ADR 0856 — tools agents may not use / must ask for in the project's chats. */
  toolPolicy?: { forbidden: string[]; requireApproval: string[] };
}
export interface TeamLedger { ledgerId: string; ownerSubject: string; version: number; updatedAt: string }
export type LedgerPatch = Partial<LedgerState>;
export interface LedgerDelta {
  deltaId: string;
  status: 'proposed' | 'accepted' | 'rejected';
  patch: LedgerPatch;
  why: string;
  author: { kind: 'user' | 'agent'; id: string };
  source?: { kind: string; ref: string };
  baseVersion: number;
  resultVersion?: number;
  rebased?: boolean;
  decidedBy?: string;
  createdAt: string;
}

const base = (projectId: string): string => `${config.baseUrl}/host/openwop-app/team-ledger/projects/${encodeURIComponent(projectId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** An HTTP failure carrying its status and the server's typed envelope (the projects-client convention). */
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    throw Object.assign(new Error(`${ctx} failed (${res.status})`), { status: res.status, ...(body !== undefined ? { body } : {}) });
  }
  return res.json() as Promise<T>;
}

export async function getTeamLedger(projectId: string): Promise<{ ledger: TeamLedger | null; state: LedgerState | null; seenVersion?: number | null }> {
  return asJson(await fetch(base(projectId), fetchOpts({ headers: authedHeaders() })), 'getTeamLedger');
}
export async function createTeamLedger(projectId: string): Promise<{ ledger: TeamLedger; state: LedgerState }> {
  return asJson(await fetch(base(projectId), fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'createTeamLedger');
}
export async function listLedgerDeltas(projectId: string): Promise<LedgerDelta[]> {
  return (await asJson<{ deltas: LedgerDelta[] }>(await fetch(`${base(projectId)}/deltas`, fetchOpts({ headers: authedHeaders() })), 'listLedgerDeltas')).deltas;
}
export async function proposeLedgerChange(projectId: string, patch: LedgerPatch, why: string, baseVersion: number): Promise<LedgerDelta> {
  return (await asJson<{ delta: LedgerDelta }>(await fetch(`${base(projectId)}/deltas`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ patch, why, baseVersion }) })), 'proposeLedgerChange')).delta;
}
export async function acceptLedgerChange(projectId: string, deltaId: string, rebased = false): Promise<void> {
  await asJson(await fetch(`${base(projectId)}/deltas/${encodeURIComponent(deltaId)}/accept`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(rebased ? { rebased: true } : {}) })), 'acceptLedgerChange');
}
export async function rejectLedgerChange(projectId: string, deltaId: string): Promise<void> {
  await asJson(await fetch(`${base(projectId)}/deltas/${encodeURIComponent(deltaId)}/reject`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'rejectLedgerChange');
}

/** ADR 0831 D1 — "I have looked at version N", stored on the server for the
 *  signed-in person (it follows them across devices). Never moves backward. */
export async function markSeen(projectId: string, version: number): Promise<number> {
  const r = await asJson<{ seenVersion: number }>(await fetch(`${base(projectId)}/seen`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ version }) })), 'markLedgerSeen');
  return r.seenVersion;
}

/** The pre-D1 per-browser value, read ONCE to carry it to the server, then removed. */
export function takeLegacySeenVersion(projectId: string): number | null {
  try {
    const key = `team-ledger:seen:${projectId}`;
    const v = Number(window.localStorage.getItem(key));
    window.localStorage.removeItem(key);
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch { return null; }
}
/** ADR 0853 D2 — record a decision (a decision-record + a proposed delta; the owner may accept at once). */
export interface RecordDecisionInput {
  title: string; decision: string; rationale?: string;
  source?: { kind: 'message' | 'inbound' | 'approval' | 'meeting' | 'drift'; ref: string; link?: string };
  accept?: boolean;
  /** ADR 0853 D1 — recording FROM a suggestion marks it recorded. */
  suggestionId?: string;
}
export async function recordDecision(projectId: string, input: RecordDecisionInput): Promise<{ documentId: string; accepted: boolean }> {
  return asJson(await fetch(`${base(projectId)}/decisions`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'recordDecision');
}

/** ADR 0853 D1 — open decision suggestions (from chat, inbound, approvals, meetings, drift). */
export interface DecisionSuggestion {
  suggestionId: string; projectId: string; title: string; text: string;
  source: { kind: 'message' | 'inbound' | 'approval' | 'meeting' | 'drift'; ref: string; link?: string };
  suggestedBy: { kind: 'agent' | 'host' | 'user'; id: string }; status: 'open' | 'recorded' | 'dismissed'; createdAt: string;
}
export async function listDecisionSuggestions(projectId: string): Promise<DecisionSuggestion[]> {
  return (await asJson<{ suggestions: DecisionSuggestion[] }>(await fetch(`${base(projectId)}/suggestions`, fetchOpts({ headers: authedHeaders() })), 'listDecisionSuggestions')).suggestions;
}
export async function dismissDecisionSuggestion(projectId: string, suggestionId: string, reason?: string): Promise<void> {
  await asJson(await fetch(`${base(projectId)}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(reason ? { reason } : {}) })), 'dismissDecisionSuggestion');
}
/** ADR 0855 D2 — return a drift finding to the person who started the run. */
export async function sendBackDriftSuggestion(projectId: string, suggestionId: string, note: string): Promise<void> {
  await asJson(await fetch(`${base(projectId)}/suggestions/${encodeURIComponent(suggestionId)}/send-back`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ note }) })), 'sendBackDriftSuggestion');
}

/** ADR 0852 D4/D5 — read-only summaries of several projects' ledgers (unreadable ones are omitted). */
export interface LedgerSummary {
  projectId: string; name: string; hasLedger: boolean; version?: number; goal?: string;
  openQuestions?: string[]; openQuestionCount?: number; pending?: number; decisionCount?: number;
}
export async function getLedgerSummaries(projectIds: readonly string[]): Promise<LedgerSummary[]> {
  const q = encodeURIComponent(projectIds.join(','));
  const r = await asJson<{ summaries: LedgerSummary[] }>(await fetch(`${config.baseUrl}/host/openwop-app/team-ledger/summaries?projectIds=${q}`, fetchOpts({ headers: authedHeaders() })), 'getLedgerSummaries');
  return r.summaries;
}
