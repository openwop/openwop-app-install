/**
 * Central client-storage helper (ADR 0434 / threat-model-secret-leakage). The key
 * registry never classes a key `secret`; `diag` keys live in sessionStorage (tab
 * lifetime) and never land in localStorage; JSON reads are guard-validated and fall
 * back rather than surfacing a foreign shape; remove really removes.
 *
 * (Subject scoping — one user never reading another's `content` keys — is
 * `src/auth/__tests__/localContentAdoption.test.ts`; the tri-state is storageSubject.test.)
 *
 * Sabotage that turns it red: route every area to localStorage; return the parsed value
 * without the guard; class a key `secret`; make writeRaw or removeRaw a no-op.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { STORAGE_KEYS, readJson, writeJson, readRaw, writeRaw, removeRaw } from '../storage.js';

describe('central storage helper', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('no registered key is classified as secret (threat-model-secret-leakage)', () => {
    for (const spec of Object.values(STORAGE_KEYS)) {
      // The DataClass union has no 'secret' member by design; assert the
      // registry never sneaks one in via a widened cast.
      expect(['ref', 'pref', 'content', 'diag']).toContain(spec.cls);
    }
  });

  it('round-trips JSON with a guard', () => {
    const isNum = (v: unknown): v is number => typeof v === 'number';
    expect(writeJson(STORAGE_KEYS.runsDensity, 3)).toBe(true);
    expect(readJson(STORAGE_KEYS.runsDensity, isNum, 0)).toBe(3);
  });

  it('returns fallback when the guard rejects the stored shape', () => {
    writeRaw(STORAGE_KEYS.runsDensity, '"not a number"');
    const isNum = (v: unknown): v is number => typeof v === 'number';
    expect(readJson(STORAGE_KEYS.runsDensity, isNum, 42)).toBe(42);
  });

  it('routes diag keys to sessionStorage, prefs to localStorage', () => {
    writeRaw(STORAGE_KEYS.networkRecorder, 'x');
    writeRaw(STORAGE_KEYS.theme, 'dark');
    expect(sessionStorage.getItem('openwop.networkRecorder.v1')).toBe('x');
    expect(localStorage.getItem('openwop.theme')).toBe('dark');
    expect(localStorage.getItem('openwop.networkRecorder.v1')).toBeNull();
  });

  it('remove clears the key', () => {
    writeRaw(STORAGE_KEYS.theme, 'dark');
    removeRaw(STORAGE_KEYS.theme);
    expect(readRaw(STORAGE_KEYS.theme)).toBeNull();
  });
});
