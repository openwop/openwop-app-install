/**
 * ADR 0363 P3 — the backend content-a11y rules twin. These cases use the SAME
 * fixtures as the FE `a11y/__tests__/contentA11y.test.ts` so the FE↔BE twin can't
 * drift (same model → same kind/wcag). The backend returns locale-free issues.
 * The one deliberate parser narrowing (oklch/named skip on BE) is asserted
 * separately below, not hidden inside a "mirror" fixture.
 */
import { describe, it, expect } from 'vitest';
import { checkContentA11y, coerceContentA11yModel, type ContentA11yModel } from '../src/host/contentA11y.js';

const empty: ContentA11yModel = { images: [], headings: [], links: [] };

describe('backend contentA11y twin', () => {
  it('missing-alt (1.1.1): flags non-decorative no-alt, passes alt/decorative', () => {
    expect(checkContentA11y({ ...empty, images: [{ alt: '' }] })).toEqual([{ kind: 'missing-alt', severity: 'error', wcag: '1.1.1' }]);
    expect(checkContentA11y({ ...empty, images: [{ alt: 'A cat' }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, images: [{ decorative: true }] })).toEqual([]);
  });

  it('heading-skip (1.3.1): flags a jump, allows one-step + base', () => {
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 3 }] })).toEqual([{ kind: 'heading-skip', severity: 'error', wcag: '1.3.1' }]);
    expect(checkContentA11y({ ...empty, headings: [{ level: 1 }, { level: 2 }, { level: 3 }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, headings: [{ level: 2 }, { level: 3 }] })).toEqual([]);
  });

  it('link-text (2.4.4): flags empty + generic, passes descriptive', () => {
    expect(checkContentA11y({ ...empty, links: [{ text: '' }] })).toEqual([{ kind: 'link-text', severity: 'warning', wcag: '2.4.4' }]);
    expect(checkContentA11y({ ...empty, links: [{ text: 'Click here' }] })).toEqual([{ kind: 'link-text', severity: 'warning', wcag: '2.4.4' }]);
    expect(checkContentA11y({ ...empty, links: [{ text: 'View the Q3 report' }] })).toEqual([]);
  });

  it('low-contrast (1.4.3): flags a weak hex pair, passes strong, skips unparseable (FE-parity fixtures)', () => {
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#777777', bg: '#808080' }] })).toEqual([{ kind: 'low-contrast', severity: 'warning', wcag: '1.4.3' }]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: '#000000', bg: '#ffffff' }] })).toEqual([]);
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: 'not-a-color', bg: '#fff' }] })).toEqual([]); // FE also skips this
  });

  it('deliberate BE-only narrowing: oklch/named colors skip (fail-safe) — the FE parses oklch, the twin does not', () => {
    // Documented divergence: the BE parser is hex/rgb-only, so an oklch pair
    // under-reports (skips) rather than mis-reporting. Reachable only via inline
    // colorPairs on the check node/tool (no live projector emits them).
    expect(checkContentA11y({ ...empty, colorPairs: [{ fg: 'oklch(0.5 0.1 30)', bg: '#ffffff' }] })).toEqual([]);
  });

  it('preserves nodeRef and aggregates across categories', () => {
    const issues = checkContentA11y({ images: [{ alt: '', ref: 'img1' }], headings: [{ level: 1 }, { level: 4 }], links: [{ text: 'here' }] });
    expect(issues.map((i) => i.kind).sort()).toEqual(['heading-skip', 'link-text', 'missing-alt']);
    expect(issues.find((i) => i.kind === 'missing-alt')?.nodeRef).toBe('img1');
  });

  it('coerceContentA11yModel: bounds arrays, drops junk, defaults heading level', () => {
    const m = coerceContentA11yModel({ images: [{ alt: 5, ref: 'x' }], headings: [{}], links: 'nope', colorPairs: [{ fg: '#000', bg: '#fff', large: true }] });
    expect(m.images).toEqual([{ alt: undefined, decorative: false, ref: 'x' }]);
    expect(m.headings).toEqual([{ level: 1, ref: undefined }]);
    expect(m.links).toEqual([]);
    expect(m.colorPairs).toEqual([{ fg: '#000', bg: '#fff', ref: undefined, large: true }]);
  });
});
