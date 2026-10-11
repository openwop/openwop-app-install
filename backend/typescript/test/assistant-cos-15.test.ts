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
 *
 * The same forced branch carries the COS-13 bootstrap-failure observability event
 * (`assistant_capability_bootstrap_failed`, an error-level line on stderr), which
 * `assistant-cos-5-7-13.test.ts`'s header used to claim; it is asserted here.
 *
 * Sabotage-witnessed (/grade-tests w11, `features/assistant/capability.ts`): a 500
 * status or a non-`conflict` code reds the case, and so does dropping the remedy
 * sentence. (Before w11 the remedy was matched as `/activate|seed/`, which the
 * opening clause "could be seeded" satisfies alone, so that check was vacuous.)
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('COS-15 — bootstrap failure is a typed 409, not a bare 500', () => {
  it('throws an OpenwopError(conflict, 409) with an actionable message + a real code', async () => {
    // A fresh tenant with no capability-activated agent and no seedable one.
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    let err: unknown;
    try {
      err = await ensureAssistantAgent('t:no-seedable-agent').then(
        () => { throw new Error('expected ensureAssistantAgent to reject'); },
        (e: unknown) => e,
      );
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(OpenwopError);
    const oe = err as OpenwopError;
    // The bug: a bare Error has no httpStatus, so the generic handler 500s it.
    expect(oe.httpStatus).toBe(409);
    // `conflict` is a member of OpenwopErrorCode (the tracker's suggested
    // `failed_precondition` is NOT — the same substitution COS-5 had to make).
    expect(oe.code).toBe('conflict');
    // Names the remedy rather than an opaque failure.
    expect(oe.message).toMatch(/assistant/i);
    expect(oe.message).toMatch(/Activate the 'assistant' capability on a roster agent/);
    // COS-13 — the failure is never silent: a named error-level event, with the tenant.
    const out = lines.join('');
    expect(out).toContain('assistant_capability_bootstrap_failed');
    expect(out).toContain('t:no-seedable-agent');
  });
});
