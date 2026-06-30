/**
 * CMS section validation (ADR 0027 front-page enrichment) — the new optional
 * fields + the `safeLink` CTA guard. Pure unit test over `validateSection`.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';

const data = (raw: object): Record<string, unknown> => validateSection(raw).data;

describe('cms section validation — hero CTAs + safeLink', () => {
  const hero = (ctaUrl: string) => data({ type: 'hero', data: { heading: 'H', ctaLabel: 'Go', ctaUrl } });

  it('keeps an internal app path', () => {
    expect(hero('/chat').ctaUrl).toBe('/chat');
  });
  it('strips a javascript: URL (not http(s)/mailto, not an internal path)', () => {
    expect(hero('javascript:alert(1)').ctaUrl).toBe('');
  });
  it('rejects a protocol-relative / backslash open-redirect shape', () => {
    expect(hero('//evil.com').ctaUrl).toBe('');
    expect(hero('/\\evil.com').ctaUrl).toBe('');
  });
  it('keeps a safe external https URL', () => {
    expect(hero('https://openwop.dev').ctaUrl).toBe('https://openwop.dev');
  });
  it('drops a CTA whose label is empty (no orphan url)', () => {
    expect(data({ type: 'hero', data: { heading: 'H', ctaUrl: '/chat' } }).ctaUrl).toBeUndefined();
  });
  it('preserves the hero eyebrow', () => {
    expect(data({ type: 'hero', data: { heading: 'H', eyebrow: 'v1.1' } }).eyebrow).toBe('v1.1');
  });
});

describe('cms section validation — columns layout + titles', () => {
  const cols = (layout?: string) => data({ type: 'columns', data: { ...(layout ? { layout } : {}), eyebrow: 'X', heading: 'Y', columns: [{ title: 'T', text: 'B' }] } });

  it('keeps a valid layout', () => {
    expect(cols('steps').layout).toBe('steps');
    expect(cols('stats').layout).toBe('stats');
  });
  it('defaults an unknown or missing layout to "cards"', () => {
    expect(cols('bogus').layout).toBe('cards');
    expect(cols(undefined).layout).toBe('cards');
  });
  it('preserves per-column title + body and the section eyebrow/heading', () => {
    const d = cols('cards');
    expect(d.eyebrow).toBe('X');
    expect(d.heading).toBe('Y');
    expect((d.columns as { title?: string; text?: string }[])[0]).toEqual({ title: 'T', text: 'B' });
  });
  it('keeps a safe per-card href + optional flag, and drops an unsafe href', () => {
    const d = data({ type: 'columns', data: { columns: [
      { title: 'A', text: 'a', href: '/agents', optional: true },
      { title: 'B', text: 'b', href: 'javascript:alert(1)' },
      { title: 'C', text: 'c', href: '//evil.example' },
    ] } });
    const c = d.columns as { title?: string; text?: string; href?: string; optional?: boolean }[];
    expect(c[0]).toEqual({ title: 'A', text: 'a', href: '/agents', optional: true });
    expect(c[1].href).toBeUndefined();   // javascript: scheme rejected by safeLink
    expect(c[2].href).toBeUndefined();   // protocol-relative // rejected (open-redirect shape)
  });
});

describe('cms section validation — cta band + richText head', () => {
  it('cta keeps eyebrow/heading/subheading + safeLink url', () => {
    const d = data({ type: 'cta', data: { eyebrow: 'Go', heading: 'See it', subheading: 'now', label: 'Open', url: '/chat' } });
    expect(d).toMatchObject({ eyebrow: 'Go', heading: 'See it', subheading: 'now', label: 'Open', url: '/chat' });
  });
  it('richText keeps optional eyebrow + heading', () => {
    const d = data({ type: 'richText', data: { eyebrow: 'The protocol', heading: 'Open wire', text: 'body' } });
    expect(d).toMatchObject({ eyebrow: 'The protocol', heading: 'Open wire', text: 'body' });
  });
});
