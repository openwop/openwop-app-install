/**
 * ADR 0115 Phase 5 — image-generation spend governance.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkImageBudget, recordImages, imageMaxPerDay } from '../src/host/imageGenBudget.js';

const DAY = '2026-06-24';
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(() => { delete process.env.OPENWOP_IMAGE_MAX_PER_DAY; });

describe('imageGenBudget', () => {
  it('defaults to 50/day', () => { expect(imageMaxPerDay()).toBe(50); });

  it('tracks used + remaining, denies at the cap', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '3';
    expect(await checkImageBudget('t1', DAY)).toMatchObject({ allowed: true, used: 0, remaining: 3 });
    await recordImages('t1', DAY, 2);
    expect(await checkImageBudget('t1', DAY)).toMatchObject({ allowed: true, used: 2, remaining: 1 });
    await recordImages('t1', DAY, 1);
    expect((await checkImageBudget('t1', DAY)).allowed).toBe(false); // 3/3
  });

  it('max=0 is uncapped', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '0';
    await recordImages('t2', DAY, 100);
    expect((await checkImageBudget('t2', DAY)).allowed).toBe(true);
  });

  it('MKP-3: concurrent records do not lose increments (atomic CAS)', async () => {
    process.env.OPENWOP_IMAGE_MAX_PER_DAY = '1000';
    const N = 8; // realistic per-tenant/day image concurrency; within the CAS retry budget
    await Promise.all(Array.from({ length: N }, () => recordImages('t3', DAY, 1)));
    expect((await checkImageBudget('t3', DAY)).used).toBe(N); // a read-then-write would drop some
  });
});
