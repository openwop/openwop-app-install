/**
 * CFP-1 HIGH-1 — the ignition-guard latch's OWN semantics: a first claim wins;
 * an identical claim inside the window is refused (and surfaces the recorded
 * run id); once the window elapses the same key re-claims. Backed by the durable
 * host KV via a memory:// storage, exactly as the igniter tools use it.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  claimIgnition,
  recordIgnitionRun,
  releaseIgnition,
  ignitionKey,
  __resetIgnitionClaims,
} from '../src/host/ignitionGuard.js';

const T = 'tenant-ign';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  await __resetIgnitionClaims();
});

describe('claimIgnition', () => {
  it('first claim wins; an identical claim inside the window is refused', async () => {
    const key = ignitionKey('podcasts.produce', 'nb-1', 'ep-1');
    const first = await claimIgnition(T, key, 5 * 60_000, 1_000);
    expect(first).toEqual({ claimed: true });

    const dup = await claimIgnition(T, key, 5 * 60_000, 2_000);
    expect(dup.claimed).toBe(false);
  });

  it('surfaces the recorded run id to a duplicate call', async () => {
    const key = ignitionKey('campaign-orchestration.run', 'brief-1');
    await claimIgnition(T, key, 5 * 60_000, 1_000);
    await recordIgnitionRun(T, key, 'run-abc');

    const dup = await claimIgnition(T, key, 5 * 60_000, 2_000);
    expect(dup).toEqual({ claimed: false, existingRunId: 'run-abc' });
  });

  it('re-claims once the window has elapsed (an honest re-run)', async () => {
    const key = ignitionKey('production.plan', 'org-1', 'email', '', '');
    expect(await claimIgnition(T, key, 60_000, 1_000)).toEqual({ claimed: true });
    // still inside the window → refused
    expect((await claimIgnition(T, key, 60_000, 30_000)).claimed).toBe(false);
    // past the window → re-claimed
    expect(await claimIgnition(T, key, 60_000, 100_000)).toEqual({ claimed: true });
  });

  it('a windowMs of 0 never dedups (every call re-claims)', async () => {
    const key = ignitionKey('discovery.create-collection', 'org-1', 'summer sale');
    expect(await claimIgnition(T, key, 0, 1_000)).toEqual({ claimed: true });
    expect(await claimIgnition(T, key, 0, 1_000)).toEqual({ claimed: true });
  });

  it('scopes claims per tenant and per key', async () => {
    const keyA = ignitionKey('podcasts.produce', 'nb-1', 'ep-1');
    const keyB = ignitionKey('podcasts.produce', 'nb-2', 'ep-1');
    await claimIgnition(T, keyA, 5 * 60_000, 1_000);
    // a different key is independent
    expect((await claimIgnition(T, keyB, 5 * 60_000, 1_500)).claimed).toBe(true);
    // a different tenant with the same key is independent
    expect((await claimIgnition('tenant-other', keyA, 5 * 60_000, 1_500)).claimed).toBe(true);
  });

  it('recordIgnitionRun on an absent claim is a no-op (never resurrects one)', async () => {
    const key = ignitionKey('never', 'claimed');
    await recordIgnitionRun(T, key, 'run-x');
    // a fresh claim still wins — nothing was persisted
    expect(await claimIgnition(T, key, 5 * 60_000, 1_000)).toEqual({ claimed: true });
  });

  // CFPT-2 — an igniter that claims but whose startWorkflowRun fails must RELEASE
  // the claim, so an honest retry inside the window isn't blocked by a latch that
  // guards a run which never started.
  it('releaseIgnition frees an un-ignited claim so a retry inside the window re-claims', async () => {
    const key = ignitionKey('campaign-channels.generate', 'brief-1', 'email');
    expect((await claimIgnition(T, key, 60_000, 1_000)).claimed).toBe(true);
    // dispatch failed → release
    await releaseIgnition(T, key);
    // an honest retry STILL inside the window now succeeds (not blocked by the failure)
    expect((await claimIgnition(T, key, 60_000, 2_000)).claimed).toBe(true);
  });

  it('releaseIgnition never drops a claim that already recorded a run', async () => {
    const key = ignitionKey('campaign-brief.research.run', 'brief-2');
    await claimIgnition(T, key, 60_000, 1_000);
    await recordIgnitionRun(T, key, 'run-live');
    // a stray release must be a no-op — the run is real and its dedup must hold
    await releaseIgnition(T, key);
    expect(await claimIgnition(T, key, 60_000, 2_000)).toEqual({ claimed: false, existingRunId: 'run-live' });
  });
});
