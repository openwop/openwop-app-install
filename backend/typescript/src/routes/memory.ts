/**
 * Host-extension read routes for the demo MemoryAdapter (RFC 0004).
 *
 *   GET    /v1/host/openwop-app/memory[?memoryRef=&tag=&limit=]  → { memoryRef, entries }
 *   GET    /v1/host/openwop-app/memory/:memoryId[?memoryRef=]    → { memoryRef, entry }
 *   DELETE /v1/host/openwop-app/memory/:memoryId[?memoryRef=]    → { memoryRef, memoryId, removed }
 *
 * Reads are per the agent-memory.md wire contract (host-internal writes — the
 * executor writes a run-summary on completion). DELETE is a demo-only host
 * convenience (it is NOT part of the normative agent-memory wire contract) that
 * backs `openwop memory delete` and the frontend inspector.
 *
 * Tenant-scoped from `req.tenantId` (the auth middleware), never the
 * query/body, per the CTI-1 cross-tenant isolation invariant.
 *
 * AGMEM-1 (ADR 0587 §5) — AND SUBJECT-scoped. The line above used to be the
 * WHOLE authorization story: true about the tenant, silent about the subject, and
 * that silence read as coverage. `memoryRef` is caller-supplied and a subject
 * scope is the totally-predictable `${kind}:${id}`, so any authenticated tenant
 * member could read or DELETE any person's or agent's memory. Every handler now
 * calls `assertMemoryRefAccess` BEFORE touching the store — one helper over the
 * same primitives the two sibling doors onto these rows already use.
 *
 * ADR 0979 D1 — AND ROW-scoped for the tenant ledger (`MEMORY_DEMO_REF`). Each
 * row there carries a slice of one run's OUTPUT, so it is decided by the
 * run-payload rule (`tenantMemoryAccess`): a member sees the summaries of runs
 * they started, an admin sees all, and a row they may not see is a 404, never a
 * 403. The list answers `visibility` + `canDelete` so the inspector says what it
 * shows and offers only what the server will do. Every response is projected
 * through `toMemoryEntry` (the stored `owner` stamp is host-internal).
 */

import type { Express } from 'express';
import { getMemoryEntry, listMemoryEntries, removeMemoryEntry, toMemoryEntry, MEMORY_DEMO_REF } from '../host/inMemorySurfaces.js';
import { assertMemoryRefAccess, tenantMemoryAccess } from '../host/memoryRefAccess.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.memory');

function resolveRef(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : MEMORY_DEMO_REF;
}

export function registerMemoryRoutes(app: Express): void {
  // authMiddleware() (global) rejects unauthenticated callers before these
  // handlers run; the path isn't in PUBLIC_PATH_PREFIXES. Tenant is resolved
  // exactly as run-create does (`req.tenantId ?? 'default'`) so the ledger
  // scopes to the same tenant the run wrote under. Never read tenant from the
  // query (CTI-1).
  app.get('/host/openwop-app/memory', async (req, res, next) => {
    try {
    const tenantId = req.tenantId ?? 'default';
    const memoryRef = resolveRef(req.query.memoryRef);
    await assertMemoryRefAccess(req, memoryRef, 'read');
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const limRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.floor(limRaw) : undefined;
    // RFC 0113 — optional injection budget (`?tokenBudget=`, unit = content
    // chars) + `?rank=` (recency-only honored). Absent ⇒ today's full list.
    const tbRaw = typeof req.query.tokenBudget === 'string' ? Number(req.query.tokenBudget) : NaN;
    const tokenBudget = Number.isFinite(tbRaw) && tbRaw > 0 ? Math.floor(tbRaw) : undefined;
    const rank = req.query.rank === 'recency' ? ('recency' as const) : undefined;
    const ledger = memoryRef === MEMORY_DEMO_REF ? await tenantMemoryAccess(req) : undefined;
    const entries = await listMemoryEntries(tenantId, memoryRef, {
      ...(tag ? { tag } : {}),
      ...(limit ? { limit } : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
      ...(rank ? { rank } : {}),
      ...(ledger ? { admit: ledger.admits } : {}),
    });
    res.status(200).json({
      memoryRef,
      entries: entries.map(toMemoryEntry),
      ...(ledger ? { visibility: ledger.visibility, canDelete: ledger.canDelete } : {}),
    });
    } catch (err) { next(err); }
  });

  app.get('/host/openwop-app/memory/:memoryId', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const memoryRef = resolveRef(req.query.memoryRef);
      await assertMemoryRefAccess(req, memoryRef, 'read');
      const ledger = memoryRef === MEMORY_DEMO_REF ? await tenantMemoryAccess(req) : undefined;
      const found = await getMemoryEntry(tenantId, memoryRef, req.params.memoryId);
      const entry = found && (!ledger || ledger.admits(found)) ? found : null;
      if (!entry) {
        res.status(404).json({ error: 'not_found', message: 'memory entry not found' });
        return;
      }
      res.status(200).json({ memoryRef, entry: toMemoryEntry(entry) });
    } catch (err) { next(err); }
  });

  app.delete('/host/openwop-app/memory/:memoryId', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const memoryRef = resolveRef(req.query.memoryRef);
      // 'write': deleting an agent's memory needs workspace:WRITE, not read.
      await assertMemoryRefAccess(req, memoryRef, 'write');
      if (memoryRef === MEMORY_DEMO_REF) {
        // ADR 0979 D1 — the scope first (independent of the id), then the row
        // must be one the caller sees; otherwise the same 404 an absent id gets.
        const ledger = await tenantMemoryAccess(req);
        await ledger.assertMayDelete();
        const target = await getMemoryEntry(tenantId, memoryRef, req.params.memoryId);
        if (!target || !ledger.admits(target)) {
          res.status(404).json({ error: 'not_found', message: 'memory entry not found' });
          return;
        }
      }
      const removed = await removeMemoryEntry(tenantId, memoryRef, req.params.memoryId);
      if (!removed) {
        res.status(404).json({ error: 'not_found', message: 'memory entry not found' });
        return;
      }
      res.status(200).json({ memoryRef, memoryId: req.params.memoryId, removed: true });
    } catch (err) { next(err); }
  });

  log.info('memory read routes registered (GET /host/openwop-app/memory)');
}
