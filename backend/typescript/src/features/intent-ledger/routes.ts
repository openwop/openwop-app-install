/**
 * ADR 0136 Phase 3 — intent-ledger REST (authed, host-extension, conversation-scoped).
 *
 *   GET  /v1/host/openwop-app/intent-ledger/conversations/:conversationId
 *   POST /v1/host/openwop-app/intent-ledger/conversations/:conversationId/draft   { goal?, ... } | {}
 *   PUT  /v1/host/openwop-app/intent-ledger/conversations/:conversationId         { goal, ... }
 *   POST /v1/host/openwop-app/intent-ledger/conversations/:conversationId/approve
 *   POST /v1/host/openwop-app/intent-ledger/conversations/:conversationId/reject
 *
 * conversationId == the chat sessionId. RBAC mirrors conversation-tools (toggle gate +
 * `isVisibleToAsync` IDOR-safe 404 for READ; owner-gated for the mutations). The
 * extractor only ever produces a `draft`; approval is an explicit owner action.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { tenantOf } from '../featureRoute.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { getLedger, saveLedger, validateLedgerInput } from './ledgerStore.js';
import { llmExtractLedger, isComplexRequest } from './ledgerExtractor.js';
import { readIntentLedgerStamp } from './ledgerProjection.js';
import { reckonLedger, type ToolEvent } from './ledgerReckoning.js';
import type { IntentLedger } from './types.js';

const RUN_SCAN_LIMIT = 200;

// Always-on (toggle removed, 2026-06-24) — conversation visibility/owner RBAC only.
const BASE = '/v1/host/openwop-app/intent-ledger/conversations/:conversationId';

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireVisible(req: Request, tenantId: string, conversationId: string): Promise<void> {
  const meta = await getConversationMeta(tenantId, conversationId);
  if (!meta || !(await isVisibleToAsync(meta, tenantId, actingUserOf(req)))) {
    throw new OpenwopError('not_found', `conversation "${conversationId}" not found.`, 404);
  }
}
async function requireOwner(req: Request, tenantId: string, conversationId: string): Promise<void> {
  const meta = await getConversationMeta(tenantId, conversationId);
  if (!meta || !(await isVisibleToAsync(meta, tenantId, actingUserOf(req)))) {
    throw new OpenwopError('not_found', `conversation "${conversationId}" not found.`, 404);
  }
  if (meta.ownerUserId && meta.ownerUserId !== actingUserOf(req)) {
    throw new OpenwopError('forbidden', 'Only the conversation owner may change its intent ledger.', 403);
  }
}

export function registerIntentLedgerRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  // ADR 0136 P4 — the authored-vs-completed reckoning (read-only projection over the
  // conversation's stamped runs + their recorded tool events).
  app.get(`${BASE}/reckoning`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireVisible(req, tenantId, conversationId);
      const runs = (await storage.listRuns({ tenantId, limit: RUN_SCAN_LIMIT }))
        .filter((r) => readIntentLedgerStamp(r.metadata)?.conversationId === conversationId);
      if (runs.length === 0) { res.json({ reckoning: null }); return; }
      // Latest stamped run carries the governing contract; aggregate tool events across all.
      const latest = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]!;
      const stamp = readIntentLedgerStamp(latest.metadata)!;
      const events: ToolEvent[] = [];
      for (const r of runs) {
        for (const e of await storage.listEvents(r.runId)) {
          if (e.type === 'agent.toolReturned') {
            const p = e.payload as { toolName?: unknown; status?: unknown };
            if (typeof p.toolName === 'string' && typeof p.status === 'string') events.push({ name: p.toolName, status: p.status });
          }
        }
      }
      res.json({ reckoning: reckonLedger(stamp, events) });
    } catch (err) { next(err); }
  });

  app.get(BASE, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireVisible(req, tenantId, conversationId);
      res.json({ ledger: await getLedger(tenantId, conversationId) });
    } catch (err) { next(err); }
  });

  // Draft: from a user-supplied body, OR auto-extracted from `lastUserMessage` + `ceiling`.
  app.post(`${BASE}/draft`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireOwner(req, tenantId, conversationId);
      const body = (req.body ?? {}) as { goal?: unknown; lastUserMessage?: unknown; ceiling?: unknown };
      let fields;
      if (typeof body.goal === 'string' && body.goal.trim()) {
        fields = validateLedgerInput(body);
      } else {
        const ceiling = Array.isArray(body.ceiling) ? body.ceiling.filter((x): x is string => typeof x === 'string') : [];
        const text = typeof body.lastUserMessage === 'string' ? body.lastUserMessage : '';
        // ADR 0136 — the over-friction guard, live: a trivial request doesn't warrant a
        // mission contract. (Tool ids in `ceiling` are advisory; the live loop re-clamps
        // the resolved scope to the agent's real ceiling, so an empty ceiling is safe.)
        if (!isComplexRequest(text, ceiling)) {
          throw new OpenwopError('validation_error', 'This request is simple enough not to need a mission contract — add a goal to draft one anyway.', 422);
        }
        fields = await llmExtractLedger(tenantId, text, ceiling);
        if (!fields.goal) throw new OpenwopError('validation_error', 'Could not draft a ledger from this conversation — supply a goal.', 422);
      }
      const ledger: IntentLedger = {
        ledgerId: `il-${Date.now().toString(36)}`,
        tenantId, conversationId,
        ...fields,
        status: 'draft',
        proposedBy: typeof body.goal === 'string' ? 'user' : 'extractor',
        createdAt: new Date().toISOString(),
      };
      res.json({ ledger: await saveLedger(ledger) });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const conversationId = req.params.conversationId;
      await requireOwner(req, tenantId, conversationId);
      const existing = await getLedger(tenantId, conversationId);
      if (!existing) throw new OpenwopError('not_found', 'No ledger to edit.', 404);
      if (existing.status === 'approved') throw new OpenwopError('conflict', 'An approved ledger cannot be edited — reject it first.', 409);
      const fields = validateLedgerInput(req.body);
      res.json({ ledger: await saveLedger({ ...existing, ...fields, status: 'draft' }) });
    } catch (err) { next(err); }
  });

  for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    app.post(`${BASE}/${verb}`, async (req, res, next) => {
      try {
        const tenantId = tenantOf(req);
        const conversationId = req.params.conversationId;
        await requireOwner(req, tenantId, conversationId);
        const existing = await getLedger(tenantId, conversationId);
        if (!existing) throw new OpenwopError('not_found', 'No ledger to update.', 404);
        const next2: IntentLedger = { ...existing, status, ...(status === 'approved' ? { approvedBy: actingUserOf(req) } : {}) };
        res.json({ ledger: await saveLedger(next2) });
      } catch (err) { next(err); }
    });
  }
}
