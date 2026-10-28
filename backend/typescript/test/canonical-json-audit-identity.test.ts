/**
 * ADR 0946 P2 (a0's review of #5092, item a) — `canonicalize` moved out of
 * `host/auditChainService.ts` into the pure `host/canonicalJson.ts`, so the
 * content-rules library imports no storage. The audit chain hashes with it,
 * so the move must be byte-identical:
 *
 * - a fixed object canonicalizes to a literal string and a fixed entry hashes
 *   to a literal hex (both computed before the move, and green on the pre-move
 *   code);
 * - the audit chain's `canonicalize` IS the pure module's function;
 * - a real appended entry's stored hash recomputes through the pure module, and
 *   the chain verifies.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import * as audit from '../src/host/auditChainService.js';
import { canonicalize } from '../src/host/canonicalJson.js';

const ENTRY = { tenantId: 't1', seq: 7, kind: 'governance.decision', at: '2026-10-20T00:00:00.000Z', payload: { z: 1, a: { y: [3, { b: 2, a: 1 }], x: null }, u: 'é' } };
const GOLDEN_BODY = '{"at":"2026-10-20T00:00:00.000Z","kind":"governance.decision","payload":{"a":{"x":null,"y":[3,{"a":1,"b":2}]},"u":"é","z":1},"seq":7,"tenantId":"t1"}';
const GOLDEN_HASH = '8eecd1d068bdb97219a20197784df7dd63b253137eb23213cd161d6e89093aed';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('canonical JSON — audit-chain byte identity', () => {
  it('canonicalizes and hashes a fixed entry to the pinned literals', () => {
    const body = canonicalize({ tenantId: ENTRY.tenantId, seq: ENTRY.seq, kind: ENTRY.kind, at: ENTRY.at, payload: ENTRY.payload });
    expect(body).toBe(GOLDEN_BODY);
    expect(createHash('sha256').update('0'.repeat(64) + body).digest('hex')).toBe(GOLDEN_HASH);
    expect(audit.canonicalize).toBe(canonicalize);
  });

  it('a real appended entry recomputes through the shared canonicalizer, and the chain verifies', async () => {
    const tenantId = `canon-${Date.now()}`;
    const e = await audit.appendAudit(tenantId, 'governance.decision', { b: 2, a: [1, { d: 4, c: 3 }] });
    const body = canonicalize({ tenantId: e.tenantId, seq: e.seq, kind: e.kind, at: e.at, payload: e.payload });
    expect(createHash('sha256').update(e.prevHash + body).digest('hex')).toBe(e.entryHash);
    expect((await audit.verifyChain(tenantId)).ok).toBe(true);
  });
});
