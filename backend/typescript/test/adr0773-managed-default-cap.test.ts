/**
 * ADR 0773 G-10e — the managed free tier's default daily allowance must fit a
 * Pair Canvas first draft, because graduation turns Pair ON by default for
 * every fresh install and white-label adopter, and they get this default.
 *
 * MEASURED 2026-10-05 (managed tier, MiniMax-M3, three quiet runs after B.8):
 * a first draft costs 64k-140k prompt tokens. The old default (50,000) was
 * smaller than one draft. Read through `describeOwnManagedUsage`, the same
 * target the dispatcher's cap check uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureManagedProvider, DEFAULT_MANAGED_DAILY_TOKEN_CAP, describeOwnManagedUsage } from '../src/providers/managedProvider.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

/** The largest first draft measured (run 1 after B.8, both follow-ups spent). */
const LARGEST_MEASURED_FIRST_DRAFT = 140_334;

let storage: Storage;
let saved: string | undefined;

beforeAll(async () => {
  saved = process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP;
  delete process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP;
  storage = await openStorage('memory://');
  configureManagedProvider({ storage, dataDir: mkdtempSync(join(tmpdir(), 'owp-defcap-')) });
});

afterAll(async () => {
  if (saved === undefined) delete process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP;
  else process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = saved;
  await storage.close();
});

describe('ADR 0773 G-10e — the default managed allowance fits a first draft', () => {
  it('an unset cap resolves to the default, which fits the largest measured first draft', async () => {
    const u = await describeOwnManagedUsage('t-defcap', 'user:defcap');
    expect(u?.dailyTokenCap).toBe(DEFAULT_MANAGED_DAILY_TOKEN_CAP);
    expect(DEFAULT_MANAGED_DAILY_TOKEN_CAP).toBeGreaterThan(LARGEST_MEASURED_FIRST_DRAFT);
  });

  it('an operator value still wins', async () => {
    process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = '50000';
    try {
      expect((await describeOwnManagedUsage('t-defcap', 'user:defcap'))?.dailyTokenCap).toBe(50_000);
    } finally {
      delete process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP;
    }
  });
});
