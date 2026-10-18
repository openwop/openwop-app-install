/**
 * ADR 0136 Phase 3 — intent-ledger REST (authed, host-extension, conversation-scoped).
 *
 *   GET  /v1/host/openwop-app/intent-ledger/conversations/:conversationId
 *   POST /v1/host/openwop-app/intent-ledger/conversations/:conversationId/draft   { goal?, ... } | {}
 *   PUT  /v1/host/openwop-app/intent-ledger/conversations/:conversationId         { goal, ... }
 *   POST /v1/host/openwop-app/intent-ledger/conversations/:conversationId/approve  { ledgerId, revision }
 *   POST /v1/host/openwop-app/intent-ledger/conversations/:conversationId/reject   { ledgerId, revision }
 *   GET  /v1/host/openwop-app/intent-ledger/conversations/:conversationId/reckoning
 *   GET  /v1/host/openwop-app/intent-ledger/conversations/:conversationId/prefill
 *
 * ADR 0856 D2 — in a project's chat or bound channel a draft starts from the team
 * ledger (`./inheritance.ts`): absent fields are pre-filled, and a write that drops
 * an inherited restriction is refused.
 *
 * conversationId == the chat sessionId. READ = conversation visibility (IDOR-safe
 * 404). WRITES = ADR 0896 D2 (`./authority.ts`, shared with the agent tool): EDIT
 * needs `workspace:write` + the owner; DECIDE (approve/reject) needs `workspace:write`
 * + the principal the tools act as (an ownerless conversation: a tenant admin), and
 * names the `{ ledgerId, revision }` it reviewed (D1 — approve what you saw). Every
 * write is a compare-and-swap; a lost race is a 409, never a silent overwrite. The
 * extractor only ever produces a `draft`.
 *
 * @see docs/adr/0136-intent-ledger.md
 * @see docs/adr/0896-intent-ledger-approval-authority.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { tenantOf } from '../featureRoute.js';
import { getConversationMeta, type ConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { personalTenantOf } from '../../host/requestSubject.js';
import { getLedger, ledgerDigest, ledgerRevision, newLedgerId, validateLedgerInput, writeLedger } from './ledgerStore.js';
import { ledgerToScope, readApprovalStamp } from './ledgerProjection.js';
import { reckonLedger, type ToolEvent } from './ledgerReckoning.js';
import type { IntentLedger } from './types.js';
import { assertKeepsInherited, missionInheritanceFor, prefillOf, withInheritedDefaults } from './inheritance.js';
import { assertTransition, ledgerAuthorityOf, ledgerChanged, type LedgerAuthority } from './authority.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.intent-ledger');

const RUN_SCAN_LIMIT = 200;

// Always-on (toggle removed, 2026-06-24).
const BASE = '/host/openwop-app/intent-ledger/conversations/:conversationId';

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireVisible(req: Request, tenantId: string, conversationId: string): Promise<ConversationMeta> {
  const meta = await getConversationMeta(tenantId, conversationId);
  if (!meta || !(await isVisibleToAsync(meta, tenantId, actingUserOf(req)))) {
    throw new OpenwopError('not_found', `conversation "${conversationId}" not found.`, 404);
  }
  return meta;
}

async function authorityOf(req: Request, tenantId: string, meta: ConversationMeta): Promise<LedgerAuthority> {
  const personalTenant = personalTenantOf(req);
  return ledgerAuthorityOf(tenantId, meta, actingUserOf(req), {
    ...(personalTenant ? { personalTenant } : {}),
    wildcardOperator: req.principal?.tenants?.includes('*') === true,
  });
}

async function requireEditor(req: Request, tenantId: string, conversationId: string): Promise<void> {
  const meta = await requireVisible(req, tenantId, conversationId);
  if (!(await authorityOf(req, tenantId, meta)).mayEdit) {
    throw new OpenwopError('forbidden', 'Only the conversation owner, with write access to this workspace, may change its mission.', 403);
  }
}

async function requireDecider(req: Request, tenantId: string, conversationId: string): Promise<void> {
  const meta = await requireVisible(req, tenantId, conversationId);
  if (!(await authorityOf(req, tenantId, meta)).mayDecide) {
    throw new OpenwopError('forbidden', meta.ownerUserId
      ? 'Only the conversation owner may approve or revoke its mission.'
      : 'This conversation has no owner — a workspace admin approves or revokes its mission.', 403);
  }
}

/** ADR 0896 D1 — what a decision reviewed: the row (`ledgerId`), its version
 *  (`revision`) and the exact contract shown (`digest`). All three are required — a
 *  body-less or partial decision cannot prove which text the caller saw, so it is a
 *  400 that names the fields (an old client fails closed and says why). */
function reviewedVersion(body: unknown): { ledgerId: string; revision: number; digest: string } {
  const b = (body ?? {}) as { ledgerId?: unknown; revision?: unknown; digest?: unknown };
  if (typeof b.ledgerId !== 'string' || !b.ledgerId || typeof b.revision !== 'number' || !Number.isInteger(b.revision) || typeof b.digest !== 'string' || !b.digest) {
    throw new OpenwopError('validation_error',
      'Send the mission you reviewed: `ledgerId`, `revision` and `digest`, exactly as the mission GET for this conversation returned them.',
      400, { required: ['ledgerId', 'revision', 'digest'] });
  }
  return { ledgerId: b.ledgerId, revision: b.revision, digest: b.digest };
}

/** The wire shape: a legacy row's missing revision reads as 0 (outgoing only — never
 *  the CAS `expected`), plus the contract digest a decision must echo. */
const out = (l: IntentLedger | null): (IntentLedger & { digest: string }) | null => (l ? { ...l, revision: ledgerRevision(l), digest: ledgerDigest(l) } : null);

export function registerIntentLedgerRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  // ADR 0136 P4 — the authored-vs-completed reckoning (read-only projection over the
  // conversation's stamped runs + their recorded tool events). ADR 0896 D6 — the
  // CURRENT approval's only: runs holding its stamp, events at or after that run's
  // anchor, and the contract read from the ledger, never from a run.
  app.get(`${BASE}/reckoning`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireVisible(req, tenantId, conversationId);
      const ledger = await getLedger(tenantId, conversationId);
      if (!ledger || (ledger.status !== 'approved' && ledger.status !== 'expired')) { res.json({ reckoning: null }); return; }
      const stamped = (await storage.listRuns({ tenantId, limit: RUN_SCAN_LIMIT }))
        .map((r) => ({ run: r, stamp: readApprovalStamp(r.metadata, ledger) }))
        .filter((x) => x.stamp !== null);
      if (stamped.length === 0) { res.json({ reckoning: null }); return; }
      const events: ToolEvent[] = [];
      for (const { run, stamp } of stamped) {
        for (const e of await storage.listEvents(run.runId)) {
          if (e.type !== 'agent.toolReturned') continue;
          if (stamp!.resolvedAt && e.timestamp < stamp!.resolvedAt) continue;
          const p = e.payload as { toolName?: unknown; status?: unknown };
          if (typeof p.toolName === 'string' && typeof p.status === 'string') events.push({ name: p.toolName, status: p.status });
        }
      }
      res.json({ reckoning: reckonLedger({ conversationId, scope: ledgerToScope(ledger), goal: ledger.goal, successCriteria: ledger.successCriteria }, events) });
    } catch (err) { next(err); }
  });

  // ADR 0856 D2 — what a new draft here starts from: the team ledger's goal and
  // scope (text, for the form) and the restrictions it must keep. Composed per
  // caller (nothing from a project they cannot read); `null` when nothing governs.
  app.get(`${BASE}/prefill`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireVisible(req, tenantId, conversationId);
      const inherited = await missionInheritanceFor(tenantId, conversationId, actingUserOf(req));
      res.json({
        prefill: inherited.length === 0 ? null : {
          ...prefillOf(inherited),
          sources: inherited.map((m) => ({ ...m.source, inScope: m.inScope, outOfScope: m.outOfScope })),
        },
      });
    } catch (err) { next(err); }
  });

  // ADR 0896 D2 — `viewer` says what THIS caller may do, from the predicates the
  // writes enforce, so the page offers only controls the server will honour.
  app.get(BASE, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      const meta = await requireVisible(req, tenantId, conversationId);
      res.json({ ledger: out(await getLedger(tenantId, conversationId)), viewer: await authorityOf(req, tenantId, meta) });
    } catch (err) { next(err); }
  });

  // Draft from a user-supplied goal (MANUAL). The chat-first, model-authored draft
  // path rides the `openwop:intent-ledger.draft-contract` agent tool (CFP A13).
  // ADR 0896 D1 — never over an approved mission (revoke first: B1 of the review —
  // this route used to replace a live mission with no revision and no decider).
  app.post(`${BASE}/draft`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireEditor(req, tenantId, conversationId);
      const existing = await getLedger(tenantId, conversationId);
      assertTransition(existing?.status, 'draft');
      const inherited = await missionInheritanceFor(tenantId, conversationId, actingUserOf(req));
      const fields = validateLedgerInput(withInheritedDefaults(req.body, inherited));
      assertKeepsInherited(fields, inherited);
      const written = await writeLedger(existing, {
        ledgerId: existing?.ledgerId ?? newLedgerId(),
        tenantId, conversationId,
        ...fields,
        status: 'draft',
        proposedBy: 'user',
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });
      if (!written) throw ledgerChanged();
      res.json({ ledger: out(written) });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireEditor(req, tenantId, conversationId);
      const existing = await getLedger(tenantId, conversationId);
      if (!existing) throw new OpenwopError('not_found', 'No ledger to edit.', 404);
      assertTransition(existing.status, 'draft');
      const inherited = await missionInheritanceFor(tenantId, conversationId, actingUserOf(req));
      const fields = validateLedgerInput(withInheritedDefaults(req.body, inherited));
      assertKeepsInherited(fields, inherited);
      // A redraft carries no approval (D1): the previous one's attribution is cleared.
      const redraft: IntentLedger = { ...existing, ...fields, status: 'draft' };
      delete redraft.approvedBy; delete redraft.approvedAt; delete redraft.rejectedBy; delete redraft.rejectedAt;
      const written = await writeLedger(existing, redraft);
      if (!written) throw ledgerChanged();
      res.json({ ledger: out(written) });
    } catch (err) { next(err); }
  });

  for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    app.post(`${BASE}/${verb}`, async (req, res, next) => {
      try {
        const tenantId = tenantOf(req);
        const conversationId = req.params.conversationId;
        await requireDecider(req, tenantId, conversationId);
        const reviewed = reviewedVersion(req.body);
        const existing = await getLedger(tenantId, conversationId);
        if (!existing) throw new OpenwopError('not_found', 'No ledger to update.', 404);
        if (existing.ledgerId !== reviewed.ledgerId || ledgerRevision(existing) !== reviewed.revision || ledgerDigest(existing) !== reviewed.digest) {
          log.info('intent_ledger_decision_stale', { tenantId, conversationId, ledgerId: existing.ledgerId, decision: status });
          throw ledgerChanged();
        }
        assertTransition(existing.status, status);
        const at = new Date().toISOString();
        let nextRow: IntentLedger = { ...existing, status };
        if (status === 'approved') {
          // The team ledger may have tightened since this was drafted.
          assertKeepsInherited(existing, await missionInheritanceFor(tenantId, conversationId, actingUserOf(req)));
          nextRow = { ...nextRow, approvedBy: actingUserOf(req)!, approvedAt: at };
        } else {
          // IL2CD-5 — a revoke is attributed like an approval.
          nextRow = { ...nextRow, rejectedBy: actingUserOf(req)!, rejectedAt: at };
        }
        const written = await writeLedger(existing, nextRow);
        if (!written) throw ledgerChanged();
        log.info('intent_ledger_decided', { tenantId, conversationId, ledgerId: written.ledgerId, from: existing.status, to: status, revision: written.revision });
        res.json({ ledger: out(written) });
      } catch (err) { next(err); }
    });
  }
}
