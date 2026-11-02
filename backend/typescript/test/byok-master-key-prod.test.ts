/**
 * SEC-3 — loadMasterKey() must NOT silently auto-generate a throwaway local-AES
 * master key in production. A fresh-instance disk key is unrecoverable across
 * instances and gives false at-rest assurance; production must supply
 * OPENWOP_BYOK_ENCRYPTION_KEY (or use KMS). Dev/test still auto-generates.
 *
 * TST-BBY-3 (w66 g4, sabotage-witnessed). `loadMasterKey` memoises the key at
 * module level, so every case resets that cache first (and after): without it the
 * production case passed only when it ran before the env-key case. Red when: the
 * production branch stops throwing (a key file then appears on disk); the env key
 * is replaced by any other 32 bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadMasterKey, resetCachedMasterKey } from '../src/byok/encryption.js';

const savedNodeEnv = process.env.NODE_ENV;
const savedKey = process.env.OPENWOP_BYOK_ENCRYPTION_KEY;
let dir: string;
let keyPath: string;

beforeEach(() => {
  resetCachedMasterKey();
  // A fresh, empty dir per case: the key file does not exist yet.
  dir = mkdtempSync(join(tmpdir(), 'owp-sec3-'));
  keyPath = join(dir, 'master.key');
});

afterEach(() => {
  resetCachedMasterKey();
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedKey === undefined) delete process.env.OPENWOP_BYOK_ENCRYPTION_KEY;
  else process.env.OPENWOP_BYOK_ENCRYPTION_KEY = savedKey;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadMasterKey production fail-closed (SEC-3)', () => {
  it('throws rather than auto-generating a disk key in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OPENWOP_BYOK_ENCRYPTION_KEY;
    expect(() => loadMasterKey(keyPath)).toThrow(/not configured in production/i);
    expect(existsSync(keyPath), 'no throwaway key may be written').toBe(false);
  });

  it('still accepts an explicit env key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENWOP_BYOK_ENCRYPTION_KEY = 'a'.repeat(64);
    const key = loadMasterKey(keyPath);
    // 64 × 'a' hex = 32 bytes of 0xaa, written out by hand (not via the loader).
    expect(key.equals(Buffer.alloc(32, 0xaa))).toBe(true);
    expect(existsSync(keyPath), 'the env key is used as-is, nothing is persisted').toBe(false);
  });
});
