/**
 * ADR 0458 P0 — kicktodo-metrics registers NO subject eraser. A VerifierSample measures the
 * automated JUDGE (not a person): it is enrollment-keyed, carries no subject key, and erasing
 * it would corrupt the FP/FN denominator. This asserts the deliberate decision: a host
 * subject-erasure fan-out leaves the verifier samples intact.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
// Register this half's erasers so the fan-out is realistic — none must reach metric samples.
import '../src/features/kicktodo-engagement/engagementService.js';
import '../src/features/kicktodo-community/communityService.js';
import '../src/features/kicktodo-integrations/integrationService.js';
import '../src/features/kicktodo-creator/publishService.js';
import { __test } from '../src/features/kicktodo-metrics/verifierSampleService.js';

const T = 'tenant-A';
const A = 'user:alice';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __test.samples.put({ tenantId: T, sampleId: 'enr-1', enrollmentId: 'enr-1', machineSatisfied: true, approvalId: 'ap-1', createdAt: '2026-01-01T00:00:00.000Z' });
});

describe('ADR 0458 P0 — metrics samples survive subject erasure (no eraser)', () => {
  it('a full subject-erasure fan-out leaves the verifier sample intact', async () => {
    await eraseSubject(T, A);
    expect(await __test.samples.get(`${T}::enr-1`)).not.toBeNull(); // judge-quality metric, not personal data
  });
});
