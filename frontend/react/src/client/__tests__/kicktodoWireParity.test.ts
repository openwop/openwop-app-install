/**
 * KTP-1 — the KickTodo client's wire types are HAND copies of the backend's
 * (the SPA bundle never imports backend source; the host-ext surface has no
 * generated client types — the only generated client file in this repo,
 * `eventCodemap.generated.ts`, is built from the OpenWOP corpus schemas, not
 * from feature types). `evidencePolicy: string` silently lost the union, so a
 * renamed policy would have fallen through every `===` in the SPA.
 *
 * Two halves:
 *  - VALUES: each closed union the client declares is read back out of the
 *    backend's own declaration source and compared exactly (drift in either
 *    direction is red). Sabotage: add a policy to `EvidencePolicy` in
 *    `kicktodo-core/types.ts`, or drop one from `EVIDENCE_POLICIES` → red.
 *  - TYPES: `expectTypeOf` pins the wire fields to the unions, so loosening a
 *    field back to `string` fails `scripts/check-test-types.mjs` (tsc over the
 *    test files) — vitest itself does not evaluate these at runtime.
 *
 * Not pinnable here: the backend's `TodayView.enrollments[].state` is itself
 * declared `string` (todayService.ts) though it is always filled from an
 * `EnrollmentState`; the client types it as the union it carries.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CHALLENGE_STATUSES, ENROLLMENT_STATES, EVIDENCE_POLICIES, MOVE_REFUSAL_REASONS,
  type ChallengeStatus, type ChallengeSummary, type Enrollment, type EnrollmentState, type EvidencePolicy,
  type ProgressView, type TodayAction, type TodayView,
} from '../kicktodoClient.js';

const CORE = join(import.meta.dirname, '..', '..', '..', '..', '..', 'backend/typescript/src/features/kicktodo-core');
const src = (file: string): string => readFileSync(join(CORE, file), 'utf8');
const literals = (block: string): string[] => [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
/** The string literals of `export type <name> = 'a' | 'b' …;`. */
const unionOf = (file: string, name: string): string[] => {
  const block = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(src(file))?.[1] ?? '';
  return literals(block);
};

describe('KTP-1 — kicktodo client unions match the backend declarations', () => {
  it('EvidencePolicy', () => {
    const backend = unionOf('types.ts', 'EvidencePolicy');
    expect(backend).toContain('attestation'); // positive control: the declaration was found
    expect([...EVIDENCE_POLICIES].sort()).toEqual(backend);
  });

  it('ChallengeStatus', () => {
    const backend = unionOf('types.ts', 'ChallengeStatus');
    expect(backend).toContain('published');
    expect([...CHALLENGE_STATUSES].sort()).toEqual(backend);
  });

  it('EnrollmentState', () => {
    const backend = unionOf('types.ts', 'EnrollmentState');
    expect(backend).toContain('active');
    expect([...ENROLLMENT_STATES].sort()).toEqual(backend);
  });

  it('move refusal reasons = DayMoveDeniedError reasons + the pre-flight `not-owner`', () => {
    const block = /class DayMoveDeniedError[\s\S]*?reason:([\s\S]*?)\)\s*\{/.exec(src('enrollmentService.ts'))?.[1] ?? '';
    const guard = literals(block);
    expect(guard).toContain('window');
    expect(src('replanService.ts')).toContain("new Error('not-owner')");
    expect([...MOVE_REFUSAL_REASONS].sort()).toEqual([...guard, 'not-owner'].sort());
  });

  it('the wire fields carry the unions, not `string` (type-level; checked by tsc)', () => {
    expectTypeOf<TodayAction['occurrence']['evidencePolicy']>().toEqualTypeOf<EvidencePolicy>();
    expectTypeOf<ChallengeSummary['activities'][number]['evidencePolicy']>().toEqualTypeOf<EvidencePolicy | ''>();
    expectTypeOf<ChallengeSummary['status']>().toEqualTypeOf<ChallengeStatus>();
    expectTypeOf<Enrollment['state']>().toEqualTypeOf<EnrollmentState>();
    expectTypeOf<TodayView['enrollments'][number]['state']>().toEqualTypeOf<EnrollmentState>();
    expectTypeOf<ProgressView['state']>().toEqualTypeOf<EnrollmentState>();
  });
});
