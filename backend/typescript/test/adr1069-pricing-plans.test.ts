/**
 * ADR 1069 D4 — authored `pricing.plans`: named plans for a site with no
 * billing tiers yet (DeckTalk's "Pilot · Open now"), in a NEW field because
 * `tiers` already means billing tier ids.
 *
 * Pins: a plan keeps exactly its six fields (name, status, blurb, ctaLabel,
 * ctaUrl, highlight) and nothing else, so no price can be authored; a saved
 * plan needs a name, while a locale overlay drops a nameless one instead of
 * failing; a plan link goes through the same guard as every CTA; `tiers` keeps
 * its meaning beside `plans`; and crawlers and the Markdown view carry the
 * plans (they are authored, not a billing read). The static-share half lives
 * in `sharing-route.test.ts` (it needs a minted link).
 *
 * Sabotage-witnessed: passing unknown plan keys through, dropping the name
 * check, or skipping the CTA link guard each reds a case.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const v = (data: Record<string, unknown>): Section => validateSection({ type: 'pricing', data }, 'en', 't1');
const PILOT = { name: 'Pilot', status: 'Open now', blurb: 'Your first production, made with us.', ctaLabel: 'Request a pilot', ctaUrl: '/p/pilot', highlight: true };
const SOLO = { name: 'Solo', status: 'Coming', ctaLabel: 'Join the list', ctaUrl: '/p/pilot' };

describe('ADR 1069 D4 pricing.plans — validation', () => {
  it('keeps the six plan fields and nothing else (no price can be authored)', () => {
    const s = v({ heading: 'Plans', plans: [{ ...PILOT, price: '$49', unit: '/mo', amount: 49 }, SOLO] });
    expect(s.data.plans).toEqual([PILOT, SOLO]);
  });

  it('a saved plan needs a name; an overlay drops a nameless plan instead', () => {
    expect(() => v({ plans: [{ status: 'Open now' }] })).toThrow(/pricing\.plans\[0\]\.name/);
    expect(sanitizeSectionOverlay('pricing', { plans: [{ status: 'Abierto' }, { name: 'Piloto', status: 'Abierto' }] }).plans)
      .toEqual([{ name: 'Piloto', status: 'Abierto' }]);
  });

  it('a plan link goes through the CTA guard: an unsafe URL is emptied, never stored', () => {
    for (const bad of ['javascript:alert(1)', '//evil.example', '/\\evil.example']) {
      const p = (v({ plans: [{ name: 'Pilot', ctaLabel: 'Go', ctaUrl: bad }] }).data.plans as Record<string, unknown>[])[0]!;
      expect(p.ctaUrl, bad).toBe('');
    }
    const ok = (v({ plans: [{ name: 'Org', ctaLabel: 'Talk to us', ctaUrl: 'mailto:sales@example.test' }] }).data.plans as Record<string, unknown>[])[0]!;
    expect(ok.ctaUrl).toBe('mailto:sales@example.test');
  });

  it('`tiers` keeps its meaning beside `plans`, and no plans means no field', () => {
    const s = v({ tiers: ['pro', 'bogus'], plans: [SOLO] });
    expect(s.data.tiers).toEqual(['pro']);
    expect(v({ plans: [] }).data).not.toHaveProperty('plans');
    // Bounded like every CMS string: over-long text is capped, not refused.
    expect((v({ plans: [{ name: 'x'.repeat(81) }] }).data.plans as { name: string }[])[0]!.name).toHaveLength(80);
  });
});

describe('ADR 1069 D4 pricing.plans — server projections', () => {
  const section = (): Section => v({ heading: 'Plans', blurb: 'Pilots are open now.', plans: [PILOT, SOLO] });

  it('crawlers get one article per plan, with its status, blurb and link', () => {
    const html = sectionHtml(section(), { assetBase: '/assets' })!;
    expect(html.match(/<article>/g)).toHaveLength(2);
    expect(html).toContain('<h3>Pilot</h3>\n<p>Open now</p>\n<p>Your first production, made with us.</p>\n<p><a href="/p/pilot">Request a pilot</a></p>');
    expect(html).toContain('<h3>Solo</h3>');
    expect(html).not.toMatch(/\$|\/mo/);
  });

  it('the Markdown view lists each plan under its own heading', () => {
    const md = sectionMarkdown(section(), 'https://site.example')!;
    expect(md).toContain('### Pilot\n\n*Open now*\n\nYour first production, made with us.\n\n[Request a pilot](/p/pilot)');
    expect(md).toContain('### Solo\n\n*Coming*\n\n[Join the list](/p/pilot)');
  });

  it('without plans, the projections are unchanged (heading, blurb, section CTA)', () => {
    const html = sectionHtml(v({ heading: 'Plans', blurb: 'Pick one.', ctaLabel: 'Compare', ctaUrl: '/pricing' }), { assetBase: '/assets' })!;
    expect(html).not.toContain('<article>');
    expect(html).toContain('<a href="/pricing">Compare</a>');
  });
});
