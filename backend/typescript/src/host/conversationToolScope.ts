/**
 * ADR 0834 D5 — the ONE resolution of a conversation's tool scope, shared by every
 * lane a human drives inside a conversation (the chat tool loop and realtime voice).
 *
 * It was inline in `conversationToolLoop.ts`, so voice — which runs tools inside the
 * same conversation — never applied it: a tool the owner disabled, put behind approval,
 * or put out of mandate with an intent ledger stayed callable over voice.
 *
 * Resolution (unchanged from ADR 0132 / 0136): the conversation's scope CONFIG,
 * intersected with an APPROVED intent ledger (never widens), resolved against the
 * lane's ceiling (the tools it would offer), with the ledger's approve/deny decisions
 * folded in. Read LIVE every turn — a revocation holds on `:fork` because nothing here
 * is read back from a stamp (the stamps are provenance only).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 * @see docs/adr/0136-intent-ledger.md
 */
import { getConversationMeta, type ConversationCapabilityScope } from './conversationStore.js';
import { collectConversationScopes } from './conversationScopeContributors.js';
import { resolveCapabilityScope, isNarrowing, applyApprovalDecisions, intersectScopes } from '../features/conversation-tools/scopeResolver.js';
import { computeCapabilityScopeStamp } from '../features/conversation-tools/capabilityScopeStamp.js';
import type { ToolApprovalRecord } from '../features/conversation-tools/approvalLedger.js';
import { ledgerToScope, computeIntentLedgerStamp, readIntentLedgerStamp } from '../features/intent-ledger/ledgerProjection.js';
import { getLedger, saveLedger } from '../features/intent-ledger/ledgerStore.js';
import type { RunRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.conversationToolScope');

export interface ConversationToolGateInput {
  tenantId: string;
  /** The ConversationMeta key (the chat SESSION id). */
  conversationKey: string;
  /** The tools the lane would offer — the scope only ever narrows this. */
  ceiling: readonly string[];
  approvals: readonly ToolApprovalRecord[];
  /** ADR 0834 D5 — fold the ledger's decisions only when this principal OWNS the
   *  conversation (the owner approved the tool for their own actions; a participant's
   *  voice session must not spend it). Absent ⇒ always fold (the chat lane, whose tools
   *  act as the owner). */
  foldApprovalsOnlyFor?: string;
  /** The run this turn rides (chat). Present ⇒ the intent ledger's TTL is anchored at the
   *  run's ledger stamp and the provenance stamps are written. Absent (voice — no run) ⇒
   *  the TTL is anchored at the ledger's `createdAt`, which precedes its approval, so a
   *  runless lane can only see a mandate expire SOONER, never later. */
  run?: RunRecord;
  storage?: Storage;
}

export interface ConversationToolGate {
  /** The effective scope to enforce, or undefined when nothing narrows. */
  scope?: { enabled: string[]; requireApproval: string[] };
  /** The owner of the conversation (ADR 0834 D5 — voice folds ledger approvals only
   *  for the owner's own session). */
  ownerUserId?: string;
}

export async function resolveConversationToolGate(input: ConversationToolGateInput): Promise<ConversationToolGate> {
  const { tenantId, conversationKey, ceiling, approvals, run, storage } = input;
  const meta = await getConversationMeta(tenantId, conversationKey);
  let scopeConfig: ConversationCapabilityScope | undefined = meta?.capabilityScope;

  // ADR 0136 — fold an APPROVED intent ledger into the scope (ledger ∩ chipset, never
  // widens). out_of_mandate (relative TTL elapsed) ⇒ enabled:[] (the agent may talk, not
  // act). FW2-CD-4: an EXPIRED ledger stays out of mandate. It used to be skipped (only
  // `approved` folded), so the turn after expiry fell back to the full tool set — the
  // opposite of "talk, don't act". It holds until the user drafts a new mission.
  const ledger = await getLedger(tenantId, conversationKey);
  if (ledger?.status === 'expired') {
    scopeConfig = intersectScopes(scopeConfig, { mode: 'restricted', enabled: [] });
  } else if (ledger?.status === 'approved') {
    if (run && storage) {
      const md = computeIntentLedgerStamp(run.metadata ?? {}, ledger, new Date().toISOString());
      if (md) { try { await storage.updateRun(run.runId, { metadata: md }); run.metadata = md; } catch { /* best-effort */ } }
    }
    const anchor = run ? readIntentLedgerStamp(run.metadata)?.resolvedAt : ledger.createdAt;
    const expired = ledger.expiresAtRelMs !== undefined && anchor !== undefined
      && (Date.now() - Date.parse(anchor)) > ledger.expiresAtRelMs;
    if (expired) {
      log.info('intent_ledger_out_of_mandate', { conversationId: conversationKey, ledgerId: ledger.ledgerId, lane: run ? 'run' : 'runless' });
      // Only the run lane PERSISTS expiry: its anchor is the run's own stamp. A runless
      // lane anchors at `createdAt` (earlier than the approval), which is right for
      // refusing early but must not end the mission for every other lane.
      if (run) { try { await saveLedger({ ...ledger, status: 'expired' }); } catch { /* best-effort */ } }
    }
    const ledgerScope: ConversationCapabilityScope = expired ? { mode: 'restricted', enabled: [] } : ledgerToScope(ledger);
    scopeConfig = intersectScopes(scopeConfig, ledgerScope);
  }

  // ADR 0856 D2 — feature-contributed narrowing (a team ledger's tool policy for
  // its project's chats), folded with intersectScopes: it can only narrow.
  if (meta) {
    for (const contribution of await collectConversationScopes(tenantId, meta)) scopeConfig = intersectScopes(scopeConfig, contribution);
  }

  const owner = meta?.ownerUserId ? { ownerUserId: meta.ownerUserId } : {};
  if (!isNarrowing(ceiling, scopeConfig)) return owner;
  const fold = input.foldApprovalsOnlyFor === undefined || input.foldApprovalsOnlyFor === meta?.ownerUserId;
  const scope = applyApprovalDecisions(resolveCapabilityScope(ceiling, scopeConfig), fold ? approvals : []);
  if (run && storage) {
    const md = computeCapabilityScopeStamp(run.metadata ?? {}, scope, new Date().toISOString());
    if (md) {
      try { await storage.updateRun(run.runId, { metadata: md }); run.metadata = md; }
      catch { /* best-effort provenance — never break the turn */ }
    }
  }
  return { scope, ...owner };
}
