/**
 * ADR 0655 D5 (EMWF-2) — a registry install never DOWNGRADES below the image-vendored
 * copy. Pure classifier witness: strict ⇒ refuse (loud), non-strict ⇒ skip, otherwise
 * install. Measured 2026-09-11: `core.openwop.integration` 1.1.2 vendored / 1.1.0 pinned
 * live — the WF-EM-6 fix was rmSync'd off the symlink and the pin written every boot.
 */
import { describe, expect, it } from 'vitest';
import { classifyRegistryInstall } from '../src/bootstrap/installRegistryPacks.js';

describe('ADR 0655 D5 — classifyRegistryInstall', () => {
  it('nothing vendored ⇒ install', () => {
    expect(classifyRegistryInstall({ onDisk: null, requested: '1.1.0', strict: true })).toBe('install');
  });
  it('vendored equal or OLDER than the pin ⇒ install (an upgrade is fine)', () => {
    expect(classifyRegistryInstall({ onDisk: '1.1.0', requested: '1.1.0', strict: true })).toBe('install');
    expect(classifyRegistryInstall({ onDisk: '1.0.9', requested: '1.1.0', strict: false })).toBe('install');
  });
  it('vendored NEWER than the pin: strict ⇒ REFUSE (the drift is loud, the pin still rules); non-strict ⇒ skip (keep the vendored copy)', () => {
    expect(classifyRegistryInstall({ onDisk: '1.1.2', requested: '1.1.0', strict: true })).toBe('refuse');
    expect(classifyRegistryInstall({ onDisk: '1.1.2', requested: '1.1.0', strict: false })).toBe('skip');
    expect(classifyRegistryInstall({ onDisk: '2.0.0', requested: '1.9.9', strict: false })).toBe('skip');
  });
});
