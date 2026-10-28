/**
 * `identity.md` §5 — every key the v2 schemas type as a `runId` must be
 * projected to the tenant-bound wire form.
 *
 * WHY THIS FILE EXISTS. The key set was a hand-written
 * `new Set(['runId', 'parentRunId'])` — two of the NINE keys the corpus types as
 * `runId`. `sourceRunId` was among the seven missing, so the fork 201 handed
 * back a RAW opaque id. Nothing local could see it: every in-repo test asserted
 * this host's own shape, and an unprojected id looks exactly like a valid one.
 * `v2-run-fork-refusals` caught it the moment `replay` was advertised.
 *
 * A hand-list is correct only until the corpus adds a tenth key, and its failure
 * mode is silent. The set is now derived from the vendored schemas; this file is
 * what keeps the derivation honest.
 */
import { describe, expect, it } from 'vitest';

import { projectV2RunIds, toWireRunId, V2_BOUND_ID_KEYS } from '../src/host/v2Ids.js';

const TENANT = 'acme';
const RAW = '17d6c640-6d74-4348-9a3f-f16cc14d80a6';
const WIRE = `${TENANT}/${RAW}`;

describe('v2 run-id projection key coverage', () => {
  it('projects EVERY key the v2 schemas declare as a runId', () => {
    // The seven SCALAR keys of the nine read off `schemas/v2/**` at the time of
    // writing (the two plural keys are the next case). Listed here as
    // a deliberate snapshot so a corpus addition shows up as a red test rather
    // than as a silently unprojected field.
    const KEYS = [
      'runId', 'parentRunId', 'sourceRunId', 'baselineRunId', 'childRunId',
      'enqueuedRunId', 'evalRunId',
    ];
    for (const key of KEYS) {
      const out = projectV2RunIds({ [key]: RAW }, TENANT) as Record<string, unknown>;
      expect(out[key], `${key} is typed as a runId in the v2 schemas and MUST be projected`).toBe(WIRE);
    }
  });

  it('projects ARRAYS of run ids, not only scalars', () => {
    // `contributingRunIds` and `sourceRunIds` are arrays. The old projector's
    // `typeof v === 'string'` guard skipped them entirely — a plural key would
    // have stayed raw even after being added to the set.
    for (const key of ['contributingRunIds', 'sourceRunIds']) {
      const out = projectV2RunIds({ [key]: [RAW] }, TENANT) as Record<string, unknown>;
      expect(out[key], `${key} holds run ids and each element MUST be projected`).toEqual([WIRE]);
    }
  });

  // DOUBLE GUARD (honest, named): `toWireRunId` returns an id carrying '/' as-is,
  // AND the opaque grammar refuses '/' anyway, so either check alone keeps an
  // already-bound id unchanged (8f W4 probe rk-already-bound, vacuous by design).
  // The re-probe rk-already-bound-r2 removes both.
  it('leaves an already-bound id and a foreign-grammar value alone', () => {
    expect((projectV2RunIds({ runId: WIRE }, TENANT) as Record<string, unknown>).runId).toBe(WIRE);
    expect((projectV2RunIds({ runId: 'not a run id' }, TENANT) as Record<string, unknown>).runId).toBe('not a run id');
    expect(toWireRunId(RAW, TENANT)).toBe(WIRE);
  });

  it('the derivation is non-vacuous — it finds more than the hard floor', () => {
    // Asserted on the DERIVED SET directly. The old form re-ran case 1's seven
    // keys and asserted `> 3`, which could not fail unless case 1 also failed
    // (8f W4: redundant). The floor (`deriveRunIdKeys` in v2Ids.ts) is
    // runId/parentRunId/sourceRunId/interruptId/subscriptionId/deliveryId/effectId;
    // every key below is OUTSIDE it, so each is present only if the schema walk ran.
    for (const k of ['baselineRunId', 'childRunId', 'enqueuedRunId', 'evalRunId', 'contributingRunIds', 'sourceRunIds', 'triggerSubscriptionId', 'webhookId']) {
      expect(V2_BOUND_ID_KEYS.has(k), `${k} is $ref'd to a bound-id kind in schemas/v2 and must be derived`).toBe(true);
    }
    // MEASURED 15 at 6a852d799 (an independent walk of schemas/v2/*.schema.json
    // for the five bound-id $refs). A floor, so a corpus addition does not red it.
    expect(V2_BOUND_ID_KEYS.size).toBeGreaterThanOrEqual(15);
  });

  it('a map\'s value schema binds no key, and a map of wire ids passes through unchanged (RFC 0252 fixtureRuns)', () => {
    // `fixtureRuns` is `additionalProperties: {$ref: runId}`: its ids sit under
    // task-id keys. The walk must not record the container word as a field name.
    expect(V2_BOUND_ID_KEYS.has('additionalProperties')).toBe(false);
    expect(V2_BOUND_ID_KEYS.has('patternProperties')).toBe(false);
    // The host accepts only bound ids there (routes/runs.ts readSourceRun) and
    // echoes them verbatim (RFC 0252 §E), so projection leaves the map alone.
    expect(projectV2RunIds({ fixtureRuns: { record: WIRE } }, TENANT)).toEqual({ fixtureRuns: { record: WIRE } });
  });
});
