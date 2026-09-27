/**
 * ADR 0458 P0 — kicktodo-organizations registers NO subject eraser (all rows are
 * org/circle-keyed governance/config; `addedBy`/`linkedBy` are audit attribution, not the
 * subject's personal data). This asserts the DELIBERATE decision as an executable fact: a
 * host subject-erasure fan-out — with every kicktodo eraser this half owns registered —
 * leaves the org rows intact even when the erased subject appears in their attribution.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
// Import every eraser this half registers, so the fan-out below is realistic — none must
// reach org data.
import '../src/features/kicktodo-engagement/engagementService.js';
import '../src/features/kicktodo-community/communityService.js';
import '../src/features/kicktodo-integrations/integrationService.js';
import '../src/features/kicktodo-creator/publishService.js';
import { __test } from '../src/features/kicktodo-organizations/orgProgramService.js';

const T = 'tenant-A';
const ORG = 'org-1';
const A = 'user:alice';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __test.libraries.put({ tenantId: T, orgId: ORG, entries: [{ challengeId: 'c1', version: 1, addedBy: A, addedAt: '2026-01-01T00:00:00.000Z' }], updatedAt: '2026-01-01T00:00:00.000Z' });
  await __test.cohortLinks.put({ tenantId: T, orgId: ORG, circleId: 'circ-1', linkedBy: A, linkedAt: '2026-01-01T00:00:00.000Z' });
  await __test.brandRefs.put({ tenantId: T, orgId: ORG, brandProfileId: 'bp-1', updatedAt: '2026-01-01T00:00:00.000Z' });
});

describe('ADR 0458 P0 — organizations rows survive subject erasure (no eraser)', () => {
  it('a full subject-erasure fan-out leaves org library/cohort/brand rows intact', async () => {
    await eraseSubject(T, A);
    const lib = await __test.libraries.get(`${T}::${ORG}`);
    expect(lib).not.toBeNull();
    expect(lib?.entries[0]?.addedBy).toBe(A); // attribution preserved (a governance record)
    expect(await __test.cohortLinks.get(`${T}::${ORG}::circ-1`)).not.toBeNull();
    expect(await __test.brandRefs.get(`${T}::${ORG}`)).not.toBeNull();
  });
});
