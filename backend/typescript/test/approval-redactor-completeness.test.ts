/**
 * APPR-5 — subject-erasure redactor completeness for the approvals store.
 *
 * The ADR 0464 store-wide `SubjectEraser` skips any approval whose `kind` has no
 * registered redactor (`applyApprovalRedactorsForSubject`: `if (!redactor)
 * continue`). So a NEW subject-carrying approval kind added without a redactor
 * would silently leave that kind's rows un-erasable — the exact class of gap this
 * test guards. Every `APPROVAL_KINDS` entry MUST have a registered redactor:
 * built-ins register at `approvalService` module load; a feature-owned kind
 * registers at that feature's module load or boot.
 *
 * ADR 1031 P2 — feature-owned kinds (`featureApprovalKinds()`) are covered too,
 * and the test now boots the real app instead of calling two named features'
 * registrars, so it holds for any feature (first-party or adopter) without
 * naming one.
 *
 * TST-BZB-5 (grade-tests w66). Red when a built-in kind's redactor registration is removed
 * (`funnel-publish`) or a feature-owned kind registers under a different id (claude-code).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { APPROVAL_KINDS, getRegisteredApprovalRedactorKinds } from '../src/host/approvalService.js';
import { featureApprovalKinds } from '../src/host/approvalKindRegistry.js';
import { createApp } from '../src/index.js';

beforeAll(async () => {
  // A real boot registers every feature's compliance + approval policy exactly as
  // production does (registerBackendFeatures).
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'appr5', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('approval redactor completeness (APPR-5)', () => {
  it('every PendingApproval kind has a registered subject redactor', () => {
    const registered = new Set(getRegisteredApprovalRedactorKinds());
    const missing = [...APPROVAL_KINDS, ...featureApprovalKinds()].filter((kind) => !registered.has(kind));
    expect(missing).toEqual([]);
  });
});
