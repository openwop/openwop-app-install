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
 * `getConversationMeta` + `isVisibleToAsync` predicate; the draft tool also the
 * route's EDIT predicate, `ledgerAuthorityOf` — ADR 0896 D2, so a Viewer's or a
 * removed member's chat cannot draft what their REST call could not). The READ tool
 * denies with ONE indistinguishable `not_found` (the route's IDOR-safe 404 posture)
 * and fails EMPTY of an acting user; the ACTION tool fails TYPED.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { getLedger, ledgerDigest, ledgerRevision, newLedgerId, validateLedgerInput, writeLedger } from './ledgerStore.js';
import type { IntentLedger } from './types.js';
import { assertTransition, ledgerAuthorityOf } from './authority.js';
import { OpenwopError } from '../../types.js';
import { assertKeepsInherited, missionInheritanceFor, withInheritedDefaults } from './inheritance.js';
import { untrustedToolError } from '../../host/agentToolKit.js';

export const INTENT_LEDGER_GET_TOOL_ID = 'openwop:intent-ledger.get';
export const INTENT_LEDGER_DRAFT_TOOL_ID = 'openwop:intent-ledger.draft-contract';

function toolError(error: string, message: string): { content: string; isError: true; hostMessage: true } {
  return { content: JSON.stringify({ error, message }), isError: true, hostMessage: true };
}

export function registerIntentLedgerAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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
      const notFound = untrustedToolError('not_found', 'No intent ledger was found for that conversation id (below).', conversationId);
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
            // ADR 0896 D7 — the whole contract the agent is held to.
            requireApproval: ledger.requireApproval,
            successCriteria: ledger.successCriteria,
            ...(ledger.expiresAtRelMs !== undefined ? { expiresAtRelMs: ledger.expiresAtRelMs } : {}),
            status: ledger.status,
            revision: ledgerRevision(ledger),
            digest: ledgerDigest(ledger),
            ...(ledger.approvedBy ? { approvedBy: ledger.approvedBy } : {}),
          },
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
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
      // The /draft route predicate: visible, then the EDIT authority (`workspace:write`
      // + the owner — ADR 0896 D2). Every deny is the same not_found (no existence
      // leak) except the authority refusal. IL2CD-6: the route also honours the
      // wildcard operator credential; a tool turn never carries one, so the tool is
      // never LOOSER than its route.
      const notFound = untrustedToolError('not_found', 'No conversation was found for that id (below).', conversationId);
      const meta = await getConversationMeta(scope.tenantId, conversationId);
      if (!meta || !(await isVisibleToAsync(meta, scope.tenantId, scope.actingUserId))) return notFound;
      const authority = await ledgerAuthorityOf(scope.tenantId, meta, scope.actingUserId, scope.personalTenant ? { personalTenant: scope.personalTenant } : {});
      if (!authority.mayEdit) {
        return toolError('forbidden', 'Only the conversation owner, with write access to this workspace, may draft its mission contract.');
      }
      // Don't silently clobber a live contract — an approved mission must be
      // revoked by the owner before a new draft.
      const existing = await getLedger(scope.tenantId, conversationId);
      try { assertTransition(existing?.status, 'draft'); } catch (err) {
        if (err instanceof OpenwopError) return toolError('conflict', 'An approved mission already governs this conversation — the owner must revoke it before drafting a new one.');
        throw err;
      }
      // Closed-world validation: invalid model output is a TYPED defect fed back to
      // the loop (its ONE bounded repair), never success-with-empty.
      // ADR 0856 D2 — in a project's conversation the draft starts from the team
      // ledger and may only narrow it (a dropped restriction is a typed defect).
      const inherited = await missionInheritanceFor(scope.tenantId, conversationId, scope.actingUserId);
      let fields;
      try {
        fields = validateLedgerInput(withInheritedDefaults(input, inherited));
        assertKeepsInherited(fields, inherited);
      } catch (err) {
        return untrustedToolError('validation_error', 'Invalid mission fields; the validator\'s reason is below.', err instanceof Error ? err.message : undefined);
      }
      // Persist a DRAFT only — proposedBy 'extractor' (the chat agent authored it);
      // approval stays an explicit human action.
      // ADR 0896 D1 — a CAS write that bumps the revision, so an owner reviewing the
      // previous draft cannot approve this one without seeing it.
      const ledger = await writeLedger(existing, {
        ledgerId: existing?.ledgerId ?? newLedgerId(),
        tenantId: scope.tenantId,
        conversationId,
        ...fields,
        status: 'draft',
        proposedBy: 'extractor',
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      } satisfies IntentLedger);
      if (!ledger) return toolError('conflict', 'The mission changed while drafting — read it again with intent-ledger.get, then redraft.');
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
            ...(ledger.expiresAtRelMs !== undefined ? { expiresAtRelMs: ledger.expiresAtRelMs } : {}),
            status: ledger.status,
            revision: ledgerRevision(ledger),
          },
          note: 'Draft saved. It is NOT active until the user reviews and Approves it in the Mission panel.',
        }),
      };
    },
  });
}
