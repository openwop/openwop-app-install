import { describe, it, expect, beforeEach } from 'vitest';
import { applyA11yPrefs, readReduceMotion, readContrast, writeReduceMotion, writeContrast } from '../a11yPrefs.js';

describe('a11yPrefs (ADR 0363 P4)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.removeAttribute('data-contrast');
  });

  it('defaults to system and reads back persisted overrides', () => {
    expect(readReduceMotion()).toBe('system');
    expect(readContrast()).toBe('system');
    writeReduceMotion('reduce');
    writeContrast('more');
    expect(readReduceMotion()).toBe('reduce');
    expect(readContrast()).toBe('more');
  });

  it('applies only explicit overrides as root attributes; system removes them', () => {
    applyA11yPrefs('reduce', 'more');
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('reduce');
    expect(document.documentElement.getAttribute('data-contrast')).toBe('more');
    applyA11yPrefs('system', 'system');
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);
    expect(document.documentElement.hasAttribute('data-contrast')).toBe(false);
  });

  it('rejects junk values on read', () => {
    localStorage.setItem('openwop.reduceMotion', 'bogus');
    localStorage.setItem('openwop.contrast', 'bogus');
    expect(readReduceMotion()).toBe('system');
    expect(readContrast()).toBe('system');
  });
});
