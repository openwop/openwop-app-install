/**
 * SEC-3 — loadMasterKey() must NOT silently auto-generate a throwaway local-AES
 * master key in production. A fresh-instance disk key is unrecoverable across
 * instances and gives false at-rest assurance; production must supply
 * OPENWOP_BYOK_ENCRYPTION_KEY (or use KMS). Dev/test still auto-generates.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadMasterKey } from '../src/byok/encryption.js';

const savedNodeEnv = process.env.NODE_ENV;
const savedKey = process.env.OPENWOP_BYOK_ENCRYPTION_KEY;
// A path under the OS temp dir that does not exist yet, unique per case.
const tmpKeyPath = join('/tmp', `owp-sec3-${process.pid}-master.key`);

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedKey === undefined) delete process.env.OPENWOP_BYOK_ENCRYPTION_KEY;
  else process.env.OPENWOP_BYOK_ENCRYPTION_KEY = savedKey;
  try { rmSync(tmpKeyPath, { force: true }); } catch { /* ignore */ }
});

describe('loadMasterKey production fail-closed (SEC-3)', () => {
  it('throws rather than auto-generating a disk key in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OPENWOP_BYOK_ENCRYPTION_KEY;
    expect(() => loadMasterKey(tmpKeyPath)).toThrow(/not configured in production/i);
  });

  it('still accepts an explicit env key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENWOP_BYOK_ENCRYPTION_KEY = 'a'.repeat(64);
    const key = loadMasterKey(tmpKeyPath);
    expect(key.length).toBe(32);
  });
});
