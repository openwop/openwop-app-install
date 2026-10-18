/**
 * ADR 0120 Phase 1 — memory auto-extraction consent grant (fail-closed).
 *
 * Guards `features/memory-auto-extract/grantService.ts`: an absent or revoked grant reads
 * `false`, the grantor is recorded for audit, and the read is keyed by tenant + subject.
 * The subject half of the isolation and the extraction-lane wiring live in
 * `memory-extraction-grant-key.test.ts`; the TENANT half of the read and the grantor are
 * pinned only here.
 *
 * Witnessed (wave 25 probes): `granted !== false` reds FAIL-CLOSED + isolation; storing
 * `granted: true` regardless reds revoke; `grantedBy: subject` reds grantor; a tenant-blind
 * read (`list().find(subject)`) reds isolation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { isExtractionGranted, setExtractionGrant, getExtractionGrant } from '../src/features/memory-auto-extract/grantService.js';

const T = 'mx-tenant';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('memory-extraction grant', () => {
  it('FAIL-CLOSED: not granted by default', async () => {
    expect(await isExtractionGranted(T, 'user:never-set')).toBe(false);
    expect(await getExtractionGrant(T, 'user:never-set')).toBeNull();
  });

  it('grant then revoke flips the gate', async () => {
    await setExtractionGrant(T, 'user:alice', true, 'user:alice');
    expect(await isExtractionGranted(T, 'user:alice')).toBe(true);
    await setExtractionGrant(T, 'user:alice', false, 'user:alice');
    expect(await isExtractionGranted(T, 'user:alice')).toBe(false);
  });

  it('records the grantor (audit attribution)', async () => {
    await setExtractionGrant(T, 'agent:bot', true, 'user:admin');
    const g = await getExtractionGrant(T, 'agent:bot');
    expect(g?.grantedBy).toBe('user:admin');
    expect(g?.granted).toBe(true);
  });

  it('is isolated by tenant + subject', async () => {
    await setExtractionGrant(T, 'user:bob', true, 'user:bob');
    expect(await isExtractionGranted(T, 'user:bob'), 'precondition: the row exists in T').toBe(true);
    expect(await isExtractionGranted('other-tenant', 'user:bob')).toBe(false); // different tenant
    expect(await getExtractionGrant('other-tenant', 'user:bob')).toBeNull();
    expect(await isExtractionGranted(T, 'user:carol')).toBe(false); // different subject
  });
});
