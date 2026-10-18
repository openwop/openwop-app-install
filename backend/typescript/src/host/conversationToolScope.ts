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
 * is read back from a stamp; the one exception is the intent ledger's TTL anchor, read
 * from the run's per-approval stamp so a fork re-reads the recorded clock (ADR 0896 D4).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 * @see docs/adr/0136-intent-ledger.md
 */
import { getConversationMeta, type ConversationCapabilityScope } from './conversationStore.js';
import { collectConversationScopes } from './conversationScopeContributors.js';
import { resolveCapabilityScope, isNarrowing, applyApprovalDecisions, intersectScopes } from '../features/conversation-tools/scopeResolver.js';
import { computeCapabilityScopeStamp } from '../features/conversation-tools/capabilityScopeStamp.js';
import type { ToolApprovalRecord } from '../features/conversation-tools/approvalLedger.js';
import { ledgerToScope, readApprovalStamp, withApprovalStamp, INTENT_LEDGER_APPROVALS_KEY } from '../features/intent-ledger/ledgerProjection.js';
import { getLedger, writeLedger } from '../features/intent-ledger/ledgerStore.js';
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
   *  run's stamp for THIS approval (ADR 0896 D4; minted on first sight, never rewritten)
   *  and the provenance stamps are written. Absent (voice — no run) ⇒ the TTL is anchored
   *  at the approval itself (`approvedAt`, legacy `createdAt`), which precedes every run
   *  under it, so a runless lane can only see a mandate expire SOONER, never later. */
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
    let anchor: string | undefined;
    let mintedHere = false;
    if (run) {
      // ADR 0896 D4 — the anchor is THIS approval's stamp on this run. A chat run spans
      // its conversation, so a stamp from an earlier mission must never anchor this one.
      let stamp = readApprovalStamp(run.metadata, ledger);
      if (!stamp) {
        // IL2CD-2 — mint from the STORED metadata (another turn may have minted it) and
        // write only this key, atomically: a whole-metadata write from the in-memory copy
        // raced every other metadata writer, and losing the map re-minted a LATER anchor.
        let base: Record<string, unknown> = run.metadata ?? {};
        if (storage) {
          try { const fresh = await storage.getRun(run.runId); if (fresh?.metadata) base = fresh.metadata as Record<string, unknown>; }
          catch (err) { log.warn('intent_ledger_stamp_read_failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) }); }
        }
        stamp = readApprovalStamp(base, ledger);
        const md = stamp ? null : withApprovalStamp(base, ledger, new Date().toISOString(), run.runId);
        if (md) {
          if (storage) {
            try { await storage.mergeRunMetadata(run.runId, { [INTENT_LEDGER_APPROVALS_KEY]: md[INTENT_LEDGER_APPROVALS_KEY] }); }
            catch (err) { log.warn('intent_ledger_stamp_write_failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) }); }
          }
          stamp = readApprovalStamp(md, ledger);
          base = md;
        }
        run.metadata = { ...(run.metadata ?? {}), [INTENT_LEDGER_APPROVALS_KEY]: base[INTENT_LEDGER_APPROVALS_KEY] };
      }
      anchor = stamp?.resolvedAt;
      mintedHere = stamp?.runId === run.runId;
    } else {
      anchor = ledger.approvedAt ?? ledger.createdAt;
    }
    const expired = ledger.expiresAtRelMs !== undefined && anchor !== undefined
      && (Date.now() - Date.parse(anchor)) > ledger.expiresAtRelMs;
    if (expired) {
      log.info('intent_ledger_out_of_mandate', { conversationId: conversationKey, ledgerId: ledger.ledgerId, lane: run ? 'run' : 'runless' });
      // Only the run lane PERSISTS expiry, and only from the run that MINTED this
      // approval's stamp (ADR 0896 D5): a `:fork` copies the entry, so it re-reads the
      // same anchor and is out of mandate itself, deterministically — but it is not the
      // run the stamp belongs to and never writes back to the live ledger. The owner's
      // run (or whichever run minted the anchor) persists it on its next turn. By CAS
      // against the row read above, so a revoke or redraft in between is never
      // overwritten. Every anchor is at or after `approvedAt` (it is minted at a turn
      // after the approval), so no run ends a mission before `approvedAt + TTL`.
      // Delta-review M1 — or once the APPROVAL's own clock has run out (`approvedAt +
      // TTL`, server-stamped, the earliest bound any lane uses): then the mission is over
      // for every lane, so any run may record it. Without this a conversation whose
      // minting run stopped taking turns (the user moved to a branch-fork) kept a stored
      // `approved` forever while every turn was out of mandate.
      const approvalClockOut = ledger.approvedAt !== undefined && ledger.expiresAtRelMs !== undefined
        && (Date.now() - Date.parse(ledger.approvedAt)) > ledger.expiresAtRelMs;
      if (run && (mintedHere || approvalClockOut)) {
        try {
          if (!(await writeLedger(ledger, { ...ledger, status: 'expired' }))) {
            log.info('intent_ledger_expiry_superseded', { conversationId: conversationKey, ledgerId: ledger.ledgerId });
          }
        } catch (err) { log.warn('intent_ledger_expiry_write_failed', { conversationId: conversationKey, error: err instanceof Error ? err.message : String(err) }); }
      }
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
