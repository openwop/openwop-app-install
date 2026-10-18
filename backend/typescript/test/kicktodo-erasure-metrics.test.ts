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
// …and the three packages whose erasers register at FEATURE BOOT, not module
// load (`register*Compliance()` from feature.ts). Without these the "full"
// fan-out silently omitted kicktodo-core — the eraser that deletes enrollments.
import { registerKicktodoCoreCompliance } from '../src/features/kicktodo-core/compliance.js';
import { registerKicktodoAccountabilityCompliance } from '../src/features/kicktodo-accountability/compliance.js';
import { registerKicktodoCommerceCompliance } from '../src/features/kicktodo-commerce/compliance.js';
import { registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import { __test } from '../src/features/kicktodo-metrics/verifierSampleService.js';

const T = 'tenant-A';
const A = 'user:alice';
const SAMPLE = { tenantId: T, sampleId: 'enr-1', enrollmentId: 'enr-1', machineSatisfied: true, approvalId: 'ap-1', createdAt: '2026-01-01T00:00:00.000Z' };

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerKicktodoCoreCompliance(); // idempotent — the seam dedupes by reference
  registerKicktodoAccountabilityCompliance();
  registerKicktodoCommerceCompliance();
  await __test.samples.put(SAMPLE);
});

describe('ADR 0458 P0 — metrics samples survive subject erasure (no eraser)', () => {
  it('a full subject-erasure fan-out leaves the verifier sample intact', async () => {
    // The fan-out really is the full KickTodo set (precondition, not assumed).
    expect(registeredSubjectEraserIds()).toEqual(expect.arrayContaining([
      'kicktodoCoreEraser', 'kicktodoAccountabilityEraser', 'kicktodoCommerceEraser',
      'eraseEngagementSubject', 'eraseCommunitySubject', 'eraseIntegrationsSubject', 'eraseCreatorSubject',
    ]));
    await eraseSubject(T, A);
    expect(await __test.samples.get(`${T}::enr-1`)).toEqual(SAMPLE); // judge-quality metric, not personal data
  });
});
