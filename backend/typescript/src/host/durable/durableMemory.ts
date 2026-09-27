/**
 * Durable RFC 0004 agent-memory store (DUR-2, ADR 0195) — backs the module-level
 * memory API in `inMemorySurfaces.ts` with the shared `Storage`, so run-summaries
 * and the recall cache survive restarts (previously "Demo only. Restarts wipe
 * state.").
 *
 * Shape: ONE kv row per (tenant, memoryRef) scope holding the ordered
 * `MemoryRow[]` (scopes are hard-capped at ~2000 rows by the policy layer, so a
 * single-row array read/write is proportionate). ALL policy — TTL filtering,
 * recency ranking, the RFC 0113 injection budget, cap eviction, compaction
 * redaction — stays in `inMemorySurfaces.ts`; this store is dumb rows. That
 * keeps ONE owner for memory semantics and makes the durable/in-memory swap a
 * pure storage change.
 *
 * Atomicity: `mutateRows` is a CAS loop (`Storage.kvCompareAndSwap`) inside the
 * per-key in-process lock — same discipline as `createKvCore.atomicIncrement` —
 * so concurrent appends (e.g. two runs completing at once against the shared
 * MEMORY_DEMO_REF) never lose a row, across instances.
 */

import type { BundleScope, MemoryRow, MemoryScopeStore } from '../inMemorySurfaces.js';
import { decodeEnvelope, requireDurableStorage, withKeyLock } from './durableStore.js';

const MAX_CAS_RETRIES = 256;

const scopeKey = (tenantId: string, memoryRef: string): string =>
  `hostsurf:memory:${encodeURIComponent(tenantId)}:${encodeURIComponent(memoryRef)}`;

function decodeRows(raw: string | null): MemoryRow[] {
  const { value } = decodeEnvelope(raw);
  return Array.isArray(value) ? (value as MemoryRow[]) : [];
}

export function createDurableMemory(scope: BundleScope): MemoryScopeStore {
  const tenantId = scope.tenantId;
  return {
    async getRows(memoryRef) {
      const raw = await requireDurableStorage().kvGet(scopeKey(tenantId, memoryRef));
      return decodeRows(raw);
    },

    async mutateRows(memoryRef, mutator) {
      const k = scopeKey(tenantId, memoryRef);
      const storage = requireDurableStorage();
      return withKeyLock(k, async () => {
        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
          const raw = await storage.kvGet(k);
          const next = mutator(decodeRows(raw));
          const res = await storage.kvCompareAndSwap(k, raw, JSON.stringify({ v: next }));
          if (res.swapped) return next;
          // Lost a cross-instance race; re-read and re-apply the mutator.
        }
        throw Object.assign(
          new Error('durable memory mutateRows: exceeded retry budget under contention'),
          { code: 'cas_contention' },
        );
      });
    },

    async clearScope(memoryRef) {
      const k = scopeKey(tenantId, memoryRef);
      const storage = requireDurableStorage();
      return withKeyLock(k, async () => {
        const n = decodeRows(await storage.kvGet(k)).length;
        await storage.kvDelete(k);
        return n;
      });
    },
  };
}
