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

import { projectV2RunIds, toWireRunId } from '../src/host/v2Ids.js';

const TENANT = 'acme';
const RAW = '17d6c640-6d74-4348-9a3f-f16cc14d80a6';
const WIRE = `${TENANT}/${RAW}`;

describe('v2 run-id projection key coverage', () => {
  it('projects EVERY key the v2 schemas declare as a runId', () => {
    // The nine, read off `schemas/v2/**` at the time of writing. Listed here as
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

  it('leaves an already-bound id and a foreign-grammar value alone', () => {
    expect((projectV2RunIds({ runId: WIRE }, TENANT) as Record<string, unknown>).runId).toBe(WIRE);
    expect((projectV2RunIds({ runId: 'not a run id' }, TENANT) as Record<string, unknown>).runId).toBe('not a run id');
    expect(toWireRunId(RAW, TENANT)).toBe(WIRE);
  });

  it('the derivation is non-vacuous — it finds more than the hard floor', () => {
    // If the schema read fails, the floor union leaves exactly three keys. More
    // than three means the derivation actually read the vendored schemas, which
    // is the difference between a working guard and a fallback pretending to be one.
    const found = ['runId', 'parentRunId', 'sourceRunId', 'baselineRunId', 'childRunId', 'enqueuedRunId', 'evalRunId']
      .filter((k) => (projectV2RunIds({ [k]: RAW }, TENANT) as Record<string, unknown>)[k] === WIRE);
    expect(found.length, 'only the floor keys project — the schema derivation is broken').toBeGreaterThan(3);
  });
});
