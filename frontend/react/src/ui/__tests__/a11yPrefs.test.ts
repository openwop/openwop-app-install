/**
 * ADR 0363 P4 — per-user accessibility overrides (reduce motion, more contrast)
 * that LAYER OVER the OS media queries. What breaks if this fails:
 *   - a junk or renamed localStorage value is trusted, and the root carries an
 *     attribute the CSS mirror rules do not expect;
 *   - `system` stamps an attribute instead of removing it, so the OS query is no
 *     longer the sole signal;
 *   - the storage KEY drifts from the one `index.html`'s inline pre-paint script
 *     reads, so the override still round-trips here but the page flashes the
 *     un-overridden motion/contrast on every load. The keys are asserted as
 *     literals AND read from `index.html` (the other side of that parity).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // Persisted under the keys the index.html pre-paint script reads.
    expect(localStorage.getItem('openwop.reduceMotion')).toBe('reduce');
    expect(localStorage.getItem('openwop.contrast')).toBe('more');
  });

  it('reads an override persisted under the pre-paint keys (the parity with index.html)', () => {
    localStorage.setItem('openwop.reduceMotion', 'reduce');
    localStorage.setItem('openwop.contrast', 'more');
    expect(readReduceMotion()).toBe('reduce');
    expect(readContrast()).toBe('more');
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain("localStorage.getItem('openwop.reduceMotion')");
    expect(html).toContain("localStorage.getItem('openwop.contrast')");
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
