/**
 * Intent-ledger agent tools (XCH-HOLE-7, LLM-EXCHANGE-AUDIT round 3) — the
 * ADR 0308 seam, plus the CFP A13 chat-first drafting tool.
 *
 * - `openwop:intent-ledger.get` (READ) — "what did we agree this conversation is
 *   FOR?" (the ADR 0136 mission contract: goal, allowed, forbidden, criteria).
 * - `openwop:intent-ledger.draft-contract` (ACTION) — the sanctioned replacement
 *   for the modal's bespoke `llmExtractLedger` call: the chat agent (which IS the
 *   model) authors the contract fields IN-CONVERSATION and this tool validates +
 *   persists a `status:'draft'` row. It NEVER approves — the human approves in the
 *   Mission panel via the existing owner-gated route (read-before-write: pair with
 *   `.get`). No second managed-LLM dispatch hides behind a button any more.
 *
 * Both tools mirror their route's authorization VERBATIM (the same
 * `getConversationMeta` + `isVisibleToAsync` predicate). The READ tool denies with
 * ONE indistinguishable `not_found` (the route's IDOR-safe 404 posture) and fails
 * EMPTY of an acting user; the ACTION tool is owner-gated and fails TYPED.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { getLedger, saveLedger, validateLedgerInput } from './ledgerStore.js';
import type { IntentLedger } from './types.js';

export const INTENT_LEDGER_GET_TOOL_ID = 'openwop:intent-ledger.get';
export const INTENT_LEDGER_DRAFT_TOOL_ID = 'openwop:intent-ledger.draft-contract';

function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

export function registerIntentLedgerAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 review H4 — the WORST-POLARITY member of this class. The payload
    // carries the mission contract's `allowed` AND `forbidden` tool-id arrays;
    // under `lossy` a `forbidden` list of five or more truncates, so a
    // PROHIBITION silently disappears from what the model is told. Honest
    // bound, stated so nobody over-claims it: enforcement is server-side, so
    // this is model MISINFORMATION, not privilege escalation — the model is
    // told it may do something the host will still refuse. That is still the
    // one direction where a shortened list is worse than a shortened list.
    schemaCarrying: true,
    def: {
      name: INTENT_LEDGER_GET_TOOL_ID,
      description:
        "Read a conversation's intent ledger (mission contract): the agreed goal, allowed and forbidden actions, "
        + 'and success criteria. Use it BEFORE acting on long-running work so you stay inside the mandate. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'The conversation whose ledger to read.' },
        },
        required: ['conversationId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
      if (!conversationId) return toolError('validation_error', '`conversationId` is required.');
      // By-id GET convention (documents.get): a turn without a human subject
      // is denied structured — `isVisibleToAsync(meta, t, undefined)` would
      // otherwise admit legacy UNOWNED conversations to system/heartbeat runs
      // (grade-pass finding, 2026-07-15).
      if (!scope.actingUserId) {
        return toolError('acting_user_required', 'Intent-ledger reads run on behalf of a signed-in user.');
      }
      // The route's requireVisible, verbatim: meta + visibility with the
      // acting user as subject; every deny is the same not_found (no
      // existence leak — invisible and nonexistent are indistinguishable).
      const notFound = toolError('not_found', `No intent ledger found for conversation "${conversationId}".`);
      const meta = await getConversationMeta(scope.tenantId, conversationId);
      if (!meta || !(await isVisibleToAsync(meta, scope.tenantId, scope.actingUserId))) return notFound;
      const ledger = await getLedger(scope.tenantId, conversationId);
      if (!ledger) return notFound;
      return {
        content: JSON.stringify({
          ledger: {
            conversationId: ledger.conversationId,
            goal: ledger.goal,
            allowed: ledger.allowed,
            forbidden: ledger.forbidden,
            successCriteria: ledger.successCriteria,
            status: ledger.status,
            ...(ledger.approvedBy ? { approvedBy: ledger.approvedBy } : {}),
          },
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: INTENT_LEDGER_DRAFT_TOOL_ID,
      description:
        'Draft a pre-flight mission contract for THIS conversation from what the user asked: the goal, the tools '
        + 'the mission may use (allowed), tools it must NOT use (forbidden), tools needing per-call approval, and '
        + 'observable success criteria. Read the current mission with intent-ledger.get FIRST. Saves a DRAFT only — '
        + 'it never takes effect until the user reviews and Approves it in the Mission panel. Be conservative: only '
        + 'request tools the goal needs.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the agent should accomplish (required).' },
          allowed: { type: 'array', items: { type: 'string' }, description: 'Tool ids/prefixes the mission may use.' },
          forbidden: { type: 'array', items: { type: 'string' }, description: 'Tool ids/prefixes the mission must NOT use.' },
          requireApproval: { type: 'array', items: { type: 'string' }, description: 'Tool ids/prefixes needing per-call human approval.' },
          successCriteria: { type: 'array', items: { type: 'string' }, description: 'Observable done-conditions.' },
          expiresAtRelMs: { type: 'number', description: 'Optional TTL from run start, in ms.' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // ACTION tool — owner-gated write, so a turn without a human subject fails
      // TYPED (never a silent empty like the read tool).
      if (!scope.actingUserId) {
        return toolError('acting_user_required', 'Drafting a mission contract runs on behalf of a signed-in user.');
      }
      // The conversation is the UNFORGEABLE run scope (ADR 0309), NOT a
      // model-supplied id: an agent can only draft a mission for the conversation
      // it is actually running inside.
      const conversationId = scope.conversationId?.trim();
      if (!conversationId) {
        return toolError('conversation_required', 'This turn is not bound to a conversation, so there is no mission to draft.');
      }
      // requireOwner, verbatim (the /draft route predicate): visible + owner. Every
      // deny is the same not_found (no existence leak) except the owner mismatch.
      const notFound = toolError('not_found', `No conversation found for "${conversationId}".`);
      const meta = await getConversationMeta(scope.tenantId, conversationId);
      if (!meta || !(await isVisibleToAsync(meta, scope.tenantId, scope.actingUserId))) return notFound;
      if (meta.ownerUserId && meta.ownerUserId !== scope.actingUserId) {
        return toolError('forbidden', 'Only the conversation owner may draft its mission contract.');
      }
      // Don't silently clobber a live contract — an approved mission must be
      // revoked by the owner before a new draft.
      const existing = await getLedger(scope.tenantId, conversationId);
      if (existing?.status === 'approved') {
        return toolError('conflict', 'An approved mission already governs this conversation — the owner must revoke it before drafting a new one.');
      }
      // Closed-world validation: invalid model output is a TYPED defect fed back to
      // the loop (its ONE bounded repair), never success-with-empty.
      let fields;
      try {
        fields = validateLedgerInput(input);
      } catch (err) {
        return toolError('validation_error', err instanceof Error ? err.message : 'Invalid mission fields.');
      }
      // Persist a DRAFT only — proposedBy 'extractor' (the chat agent authored it);
      // approval stays an explicit human action.
      const ledger: IntentLedger = {
        ledgerId: existing?.ledgerId ?? `il-${Date.now().toString(36)}`,
        tenantId: scope.tenantId,
        conversationId,
        ...fields,
        status: 'draft',
        proposedBy: 'extractor',
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await saveLedger(ledger);
      return {
        content: JSON.stringify({
          drafted: true,
          ledger: {
            conversationId,
            goal: ledger.goal,
            allowed: ledger.allowed,
            forbidden: ledger.forbidden,
            requireApproval: ledger.requireApproval,
            successCriteria: ledger.successCriteria,
            status: ledger.status,
          },
          note: 'Draft saved. It is NOT active until the user reviews and Approves it in the Mission panel.',
        }),
      };
    },
  });
}
