/**
 * COS-15 (docs/steward/CODEBASE-ASSESSMENT.md) — a bootstrap failure on a tenant
 * with no seedable assistant agent must be a TYPED refusal, not a bare 500.
 *
 * `ensureAssistantAgent` used to throw `Object.assign(new Error(…), {code})` with
 * NO `status`, so `enqueueActionWithApproval` / `enableLoop` bubbled it to the
 * generic handler as an opaque 500 with no operator guidance — precisely the shape
 * a white-label install hits when seeding is capability-gated and
 * `ensureSeededAgentByRole` returns null. The fix throws an `OpenwopError` with a
 * real `OpenwopErrorCode` (`conflict`, 409) naming the remedy.
 *
 * `ensureSeededAgentByRole` returns null only when no seed spec matches the role —
 * which the shipped `chief-of-staff` spec always satisfies — so the null branch is
 * forced by mocking it (the module boundary the capability resolver depends on).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { OpenwopError } from '../src/types.js';

vi.mock('../src/host/exampleDataSeed.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/host/exampleDataSeed.js')>();
  return { ...actual, ensureSeededAgentByRole: async () => null };
});

import { ensureAssistantAgent } from '../src/features/assistant/capability.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => vi.clearAllMocks());

describe('COS-15 — bootstrap failure is a typed 409, not a bare 500', () => {
  it('throws an OpenwopError(conflict, 409) with an actionable message + a real code', async () => {
    // A fresh tenant with no capability-activated agent and no seedable one.
    const err = await ensureAssistantAgent('t:no-seedable-agent').then(
      () => { throw new Error('expected ensureAssistantAgent to reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenwopError);
    const oe = err as OpenwopError;
    // The bug: a bare Error has no httpStatus, so the generic handler 500s it.
    expect(oe.httpStatus).toBe(409);
    // `conflict` is a member of OpenwopErrorCode (the tracker's suggested
    // `failed_precondition` is NOT — the same substitution COS-5 had to make).
    expect(oe.code).toBe('conflict');
    // Names the remedy rather than an opaque failure.
    expect(oe.message).toMatch(/assistant/i);
    expect(oe.message).toMatch(/activate|seed/i);
  });
});
