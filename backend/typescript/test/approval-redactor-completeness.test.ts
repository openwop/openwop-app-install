/**
 * APPR-5 — subject-erasure redactor completeness for the approvals store.
 *
 * The ADR 0464 store-wide `SubjectEraser` skips any approval whose `kind` has no
 * registered redactor (`applyApprovalRedactorsForSubject`: `if (!redactor)
 * continue`). So a NEW subject-carrying approval kind added without a redactor
 * would silently leave that kind's rows un-erasable — the exact class of gap this
 * test guards. Every `APPROVAL_KINDS` entry MUST have a registered redactor:
 * built-ins register at `approvalService` module load; a feature-owned kind
 * (kicktodo-plan-proposal) registers at that feature's boot.
 */
import { describe, it, expect } from 'vitest';
import { APPROVAL_KINDS, getRegisteredApprovalRedactorKinds } from '../src/host/approvalService.js';
import { registerKicktodoAccountabilityCompliance } from '../src/features/kicktodo-accountability/compliance.js';

describe('approval redactor completeness (APPR-5)', () => {
  it('every PendingApproval kind has a registered subject redactor', () => {
    // kicktodo-accountability OWNS its kind's redactor (registered at feature
    // boot, not at approvalService module load) — register it as production does.
    // Idempotent: the handlers are module-level constants that dedupe by reference.
    registerKicktodoAccountabilityCompliance();

    const registered = new Set(getRegisteredApprovalRedactorKinds());
    const missing = APPROVAL_KINDS.filter((kind) => !registered.has(kind));
    expect(missing).toEqual([]);
  });
});
