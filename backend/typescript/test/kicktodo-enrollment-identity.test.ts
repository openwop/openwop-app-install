/**
 * `PROBE-KTX2` (KT-EXP-5, server half) — the REACHABLE part.
 *
 * The probe asks what happens "after a challenge version bump". **That scenario
 * cannot occur.** Nothing in the repo mints a challenge version > 1: there are
 * exactly four writes to the challenges collection — `createDraft` (hardcoded
 * `version: 1`, explicit `::v1` key, `challengeService.ts:154/179`) and
 * `publishChallenge`/`retireChallenge`, which CAS an EXISTING row's status. The
 * data model anticipates versioning (`enrollmentId` hashes it, `retireLineage`
 * and `translationOf` reason about it) but no authoring path produces a v2, so
 * the probe's premise is unbuilt, not merely untested. That half is recorded in
 * the tracker rather than faked here — writing a v2 row straight into the store
 * would test my fixture, not the product.
 *
 * What IS reachable is the identity contract the bump question rests on, and it
 * carries the real risk: enrollment ids are DETERMINISTIC over
 * (tenant, subject, challenge, version) — `types.ts:207`. That is what makes a
 * double-tap converge instead of forking a participant's progress, and it is
 * what would make a future v2 a distinct enrollment rather than a silent
 * retarget. Pinning it now means the version-bump feature, when built, starts
 * from an asserted baseline instead of an assumed one.
 */
import { describe, expect, it } from 'vitest';
import { enrollmentId } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-ktx2';
const S = 'user:alice';
const C = 'chal:one';

describe('PROBE-KTX2 (executable) — enrollment identity is deterministic and version-scoped', () => {
  it('is stable for the same inputs — a re-enroll converges instead of forking progress', () => {
    const a = enrollmentId(T, S, C, 1);
    expect(a, 'precondition: an id was produced').toMatch(/^enr:[0-9a-f]{24}$/);
    expect(enrollmentId(T, S, C, 1), 're-deriving produced a DIFFERENT id — a double-tap would fork progress').toBe(a);
  });

  it('VERSION is part of the identity — a future v2 is a distinct enrollment, not a silent retarget', () => {
    expect(
      enrollmentId(T, S, C, 2),
      'v1 and v2 collapse to one enrollment — a catalogue bump would move a participant mid-challenge',
    ).not.toBe(enrollmentId(T, S, C, 1));
  });

  it('subject and challenge are part of the identity too', () => {
    // Each of these would otherwise collapse two people (or two challenges) onto
    // one enrollment row, which the deterministic key makes unrecoverable.
    expect(enrollmentId(T, 'user:bob', C, 1), 'two SUBJECTS share an enrollment').not.toBe(enrollmentId(T, S, C, 1));
    expect(enrollmentId(T, S, 'chal:two', 1), 'two CHALLENGES share an enrollment').not.toBe(enrollmentId(T, S, C, 1));
    expect(enrollmentId('other', S, C, 1), 'two TENANTS share an enrollment').not.toBe(enrollmentId(T, S, C, 1));
  });
});
