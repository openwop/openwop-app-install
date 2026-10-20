/**
 * KT-PACK-REPLAY-1 (grade-node-packs, 2026-10-14) — the KickTodo node pack's
 * non-convergent WRITERS are declared `role:"side-effect"` + `side-effectful`.
 *
 * Born red: all 33 writing nodes were `role:"action"`, and both the pack
 * description and the index.mjs header said that meant "replay/fork read the
 * recorded result". It does not: nothing under `src/executor/` reads `action`
 * (`host/featureSurfaces.ts`, the CSMCD-13 correction). Only `session-reminder`
 * was protected, by a hand regex in `executor/sideEffects.ts`. A `:fork` of the
 * reminder loop re-sent the reminder and re-queued the KickBot turn; a fork of
 * the replan chain re-applied the participant's revision commands.
 *
 * The seven classified nodes each re-execute OBSERVABLY:
 *   remind-today         — notification emit, no dedupe (calendarWriteService routeReminder)
 *   session-reminder     — notification emit (accountability sessionService)
 *   kickbot-coach-turn   — job key derives from the CURRENT local day (kickbotCoachTurnService)
 *   create-candidate     — mints a fresh candidate id (creatorService createCandidate)
 *   propose-plan-change  — mints a proposal + a host approval (cohortService proposePlanChange)
 *   apply-revision-commands — schedule/substitute/move lanes do not converge (replanService)
 *   calendar-sync        — writes an EXTERNAL calendar (calendarWriteService)
 *
 * JUDGED CONVERGENT, left `action` (recorded, not omitted): enroll (idempotent
 * saga), materialize-today, check-in, substitute, set-schedule-preference,
 * referral-code (resolve-or-mint), submit-publication (returns the existing
 * publication). Revisit if any gains a notification or a minted id.
 *
 * None of the seven reaches `ctx.callAI`, so all seven are fast-path SERVED, not
 * held back as invocation-log nodes.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { pinnedPackRef } from '../src/features/packPins.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK_DIR = join(REPO, 'packs', 'feature.kicktodo.nodes');
const PACK = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as {
  version: string; description: string; nodes: { typeId: string; role: string; capabilities?: string[] }[];
};
const id = (n: string): string => `feature.kicktodo.nodes.${n}`;
const WRITERS = ['remind-today', 'session-reminder', 'kickbot-coach-turn', 'create-candidate', 'propose-plan-change', 'apply-revision-commands', 'calendar-sync'];
const CONVERGENT = ['enroll', 'materialize-today', 'check-in', 'substitute', 'set-schedule-preference', 'referral-code', 'submit-publication'];

describe('KT-PACK-REPLAY-1 — KickTodo node replay classification', () => {
  it('leg 1: the seven writers declare side-effect + side-effectful; the convergent writers stay action', () => {
    const byId = new Map(PACK.nodes.map((n) => [n.typeId, n]));
    for (const n of WRITERS) {
      expect(byId.get(id(n))?.role, n).toBe('side-effect');
      expect(byId.get(id(n))?.capabilities, n).toContain('side-effectful');
    }
    for (const n of CONVERGENT) expect(byId.get(id(n))?.role, n).toBe('action');
  });

  it('leg 2: every writer is floored AND fast-path served', () => {
    for (const n of WRITERS) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id(n)), `${n} floored`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id(n)), `${n} served — this is what stops the re-execution`).toBe(true);
      expect(isSideEffectingNode(id(n))).toBe(true);
    }
  });

  it('leg 3: the pack no longer claims role:action means replay-served, and every kicktodo pin matches', () => {
    expect(PACK.description).not.toContain('role:action so replay reads recorded outputs');
    expect(PACK.description).toContain('side-effect');
    const header = readFileSync(join(PACK_DIR, 'index.mjs'), 'utf8').slice(0, 600);
    expect(header).not.toContain('All role:"action"');
    for (const f of ['accountability', 'commerce', 'community', 'core', 'creator', 'engagement', 'integrations', 'metrics', 'organizations']) {
      const src = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', `kicktodo-${f}`, 'feature.ts'), 'utf8');
      expect(src, `kicktodo-${f} pin lags the manifest`).toContain(`'feature.kicktodo.nodes'`);
      expect(pinnedPackRef('feature.kicktodo.nodes').version, 'the pin (features/packPins.ts, ADR 0919) must match the manifest').toBe(PACK.version);
    }
  });

  it('leg 4: remind-today schemas describe the node it documents (input ownerSubject, output reminded/reason)', () => {
    const input = JSON.parse(readFileSync(join(PACK_DIR, 'schemas', 'remind-today.input.json'), 'utf8')) as { required: string[] };
    const output = JSON.parse(readFileSync(join(PACK_DIR, 'schemas', 'remind-today.output.json'), 'utf8')) as { properties: Record<string, unknown> };
    expect(input.required).toEqual(['enrollmentId', 'ownerSubject']);
    expect(Object.keys(output.properties).sort()).toEqual(['reason', 'reminded']);
  });
});
