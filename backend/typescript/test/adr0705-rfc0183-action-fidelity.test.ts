/**
 * RFC 0183 §A.1/§A.2 (ADR 0705) — an approval resolution records WHICH action
 * was applied, and the two actions whose meaning is incomplete without their
 * payload are refused when it is missing.
 *
 * WHY THIS FILE EXISTS BESIDE THE CONFORMANCE SCENARIO. Suite 2.2.0's
 * `interrupt-approval.test.ts` covers `refine` live, and that is the witness
 * that matters for conformance. It does NOT cover `edit-accept` — but §A.2 is
 * ONE sentence binding both:
 *
 *   "A host recording `action: 'refine'` MUST carry `refineFeedback`; a host
 *    recording `action: 'edit-accept'` MUST carry `editedArtifactData`."
 *
 * The host enforces both arms. Shipping only the arm the suite exercises would
 * leave a rule that greps as implemented and is not, so the untested arm gets
 * its test here rather than an assurance in a commit message.
 *
 * Legs disjoint under sabotage — MEASURED (see the PR body):
 *   drop the refine arm of assertActionPayloadComplete      -> legs 2, 3
 *   drop the edit-accept arm                                -> leg 4 alone
 *   drop resolvedActionFields from the emitted payload      -> leg 1 alone
 *   return the action for NON-approval kinds too            -> leg 5 alone
 */
import { describe, expect, it } from 'vitest';
import { validateResumeValue, resolvedActionFields } from '../src/routes/interrupts.js';
import { OpenwopError } from '../src/types.js';

const APPROVAL = (actions: string[]) => ({ kind: 'approval', data: { actions } });
const ALL = ['accept', 'reject', 'refine', 'edit-accept'];

function refusalOf(fn: () => void): OpenwopError | null {
  try { fn(); return null; } catch (e) { return e as OpenwopError; }
}

describe('RFC 0183 §A.2 — an action whose payload is missing is refused, not recorded', () => {
  it('1. a complete refine resolution is ACCEPTED (negative control)', () => {
    // First, because every refusal below is only meaningful if the happy path
    // is not being refused for some unrelated reason.
    expect(() => validateResumeValue(APPROVAL(ALL), {
      action: 'refine',
      refineFeedback: { scope: 'whole', text: 'tighten the summary' },
    })).not.toThrow();
    expect(() => validateResumeValue(APPROVAL(ALL), { action: 'accept' })).not.toThrow();
  });

  it('2. refine with NO refineFeedback is refused 400 validation_error', () => {
    const err = refusalOf(() => validateResumeValue(APPROVAL(ALL), { action: 'refine' }));
    expect(err, 'a refine with no feedback must be refused').not.toBeNull();
    expect(err?.httpStatus).toBe(400);
    expect(err?.code).toBe('validation_error');
    expect(String(err?.message)).toMatch(/refineFeedback/);
  });

  it('3. refineFeedback MUST carry a `scope` from the closed vocabulary', () => {
    // `interrupt.md` §RefineFeedback is a closed object with `required:
    // [scope]`. Only `scope` is asserted — the full closure is the schema's
    // job, and a host inventing extra refusals narrows a shape the corpus
    // deliberately left admissible.
    for (const fb of [{}, { text: 'no scope' }, { scope: 'everything' }]) {
      const err = refusalOf(() => validateResumeValue(APPROVAL(ALL), { action: 'refine', refineFeedback: fb }));
      expect(err, `refineFeedback ${JSON.stringify(fb)} must be refused`).not.toBeNull();
      expect(err?.httpStatus).toBe(400);
    }
    for (const scope of ['whole', 'section', 'items']) {
      expect(() => validateResumeValue(APPROVAL(ALL), { action: 'refine', refineFeedback: { scope } }),
        `scope ${scope} is in the vocabulary and must be accepted`).not.toThrow();
    }
  });

  it('4. edit-accept with NO editedArtifactData is refused — the arm the SUITE does not test', () => {
    const err = refusalOf(() => validateResumeValue(APPROVAL(ALL), { action: 'edit-accept' }));
    expect(err, '§A.2 binds edit-accept in the same sentence as refine').not.toBeNull();
    expect(err?.httpStatus).toBe(400);
    expect(String(err?.message)).toMatch(/editedArtifactData/);
    // …and a complete one passes, so the arm is a rule and not a blanket refusal.
    expect(() => validateResumeValue(APPROVAL(ALL), {
      action: 'edit-accept', editedArtifactData: { title: 'edited' },
    })).not.toThrow();
  });

  it('5. a NON-approval interrupt is untouched — §A.1 is OPTIONAL because the def serves eight kinds', () => {
    // Stamping an action onto a kind that has none would be inventing one, and
    // `interruptResolved` is `additionalProperties: false`, so an invented key
    // is an INVALID payload in the durable log, not merely a noisy one.
    //
    // This leg asserts `resolvedActionFields` DIRECTLY. It used to assert only
    // `validateResumeValue`, which returns early for non-approval kinds and so
    // never reaches the emit helper at all — sabotaging the helper left all six
    // legs green. A leg that cannot reach the code it names is a gate that
    // cannot fail, and this one was, until the sabotage pass said so.
    expect(resolvedActionFields('external-event', { action: 'refine' })).toEqual({});
    expect(resolvedActionFields('conversation', { action: 'accept' })).toEqual({});
    expect(() => validateResumeValue({ kind: 'external-event', data: {} }, { action: 'refine' })).not.toThrow();
  });

  it('7. an approval resolution DOES carry the action, and only the payload its action takes', () => {
    expect(resolvedActionFields('approval', { action: 'accept' })).toEqual({ action: 'accept' });
    expect(resolvedActionFields('approval', { action: 'refine', refineFeedback: { scope: 'whole' } }))
      .toEqual({ action: 'refine', refineFeedback: { scope: 'whole' } });
    // A stray payload belonging to the OTHER action is not copied through: the
    // def is closed, so carrying `editedArtifactData` on a refine would be an
    // invalid event rather than a harmless extra.
    expect(resolvedActionFields('approval', { action: 'refine', refineFeedback: { scope: 'whole' }, editedArtifactData: { x: 1 } }))
      .toEqual({ action: 'refine', refineFeedback: { scope: 'whole' } });
    // No action supplied -> nothing stamped.
    expect(resolvedActionFields('approval', {})).toEqual({});
  });

  it('6. an approval gate that does not OFFER refine is unaffected by the new rule', () => {
    // The pre-existing allowed-actions refusal still fires first, with its own
    // message — the new rule must not change which error a caller sees when
    // the action was never on offer.
    const err = refusalOf(() => validateResumeValue(APPROVAL(['accept', 'reject']), { action: 'refine' }));
    expect(err?.httpStatus).toBe(400);
    expect(String(err?.message)).toMatch(/MUST be one of/);
    expect(String(err?.message)).not.toMatch(/refineFeedback/);
  });
});
