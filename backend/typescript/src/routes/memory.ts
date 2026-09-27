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
 */

import type { Express } from 'express';
import { getMemoryEntry, listMemoryEntries, removeMemoryEntry, MEMORY_DEMO_REF } from '../host/inMemorySurfaces.js';
import { assertMemoryRefAccess } from '../host/memoryRefAccess.js';
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
  app.get('/v1/host/openwop-app/memory', async (req, res, next) => {
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
    const entries = await listMemoryEntries(tenantId, memoryRef, {
      ...(tag ? { tag } : {}),
      ...(limit ? { limit } : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
      ...(rank ? { rank } : {}),
    });
    res.status(200).json({ memoryRef, entries });
    } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/memory/:memoryId', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const memoryRef = resolveRef(req.query.memoryRef);
      await assertMemoryRefAccess(req, memoryRef, 'read');
      const entry = await getMemoryEntry(tenantId, memoryRef, req.params.memoryId);
      if (!entry) {
        res.status(404).json({ error: 'not_found', message: 'memory entry not found' });
        return;
      }
      res.status(200).json({ memoryRef, entry });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/memory/:memoryId', async (req, res, next) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const memoryRef = resolveRef(req.query.memoryRef);
      // 'write': deleting an agent's memory needs workspace:WRITE, not read.
      await assertMemoryRefAccess(req, memoryRef, 'write');
      const removed = await removeMemoryEntry(tenantId, memoryRef, req.params.memoryId);
      if (!removed) {
        res.status(404).json({ error: 'not_found', message: 'memory entry not found' });
        return;
      }
      res.status(200).json({ memoryRef, memoryId: req.params.memoryId, removed: true });
    } catch (err) { next(err); }
  });

  log.info('memory read routes registered (GET /v1/host/openwop-app/memory)');
}
