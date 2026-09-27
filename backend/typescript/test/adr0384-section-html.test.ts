/**
 * ADR 0384 Phase 1 — the server-side section→HTML renderer's drift gates.
 *
 * 1. COVERAGE: every entry in the closed SECTION_TYPES vocabulary MUST render
 *    (a new CMS section type without a server branch is a red build — the
 *    prompt-catalog-parity discipline applied to the renderer pair).
 * 2. GOLDEN: a fixture page exercising every type + every safe-markdown token
 *    against an expected-HTML snapshot — a semantic change to either renderer
 *    is reconciled deliberately, never silently.
 * 3. SAFETY: escaping, unsafe-link degradation, unknown-type fallback.
 */
import { describe, expect, it } from 'vitest';
import { SECTION_TYPES, type Section } from '../src/features/cms/cmsService.js';
import { escapeHtml, headingSlug, inlineMarkdownHtml, pageBodyHtml, sectionHtml } from '../src/features/publishing/sectionHtml.js';

// R2-D10 — KEEP IN LOCKSTEP with the frontend copy of these cases
// (frontend/react/src/features/cms/__tests__/headingSlug.test.tsx): the SPA and
// this prerender must derive the SAME anchor id from the same heading text.
const SLUG_PARITY_CASES: Array<[string, string]> = [
  ['How is pricing calculated?', 'how-is-pricing-calculated'],
  ['Café Ünïcode — done!', 'cafe-unicode-done'],
  ['***', 'section'],
  ['A'.repeat(80), 'a'.repeat(64)],
  ['  spaced   out  ', 'spaced-out'],
];

describe('headingSlug parity (R2-D10)', () => {
  it.each(SLUG_PARITY_CASES)('%s → %s', (text, slug) => {
    expect(headingSlug(text)).toBe(slug);
  });
});

const OPTS = { assetBase: 'https://app.example.test' };

/** A minimal renderable section per type (fields mirror SectionRenderer.tsx). */
function fixture(type: Section['type']): Section {
  const base = { sectionId: `sec-${type}`, type } as const;
  switch (type) {
    case 'hero':
      return { ...base, data: { eyebrow: 'Eyebrow', heading: 'Hero heading', subheading: 'Sub with **bold**', ctaLabel: 'Go', ctaUrl: '/p/next', ctaLabel2: 'Docs', ctaUrl2: 'https://example.com/d' } };
    case 'richText':
      return { ...base, data: { heading: 'Rich', text: 'Para one with *em* and `code`.\n\nPara two with [link](https://example.com).' } };
    case 'image':
      return { ...base, data: { token: 'tok-abc', alt: 'An alt', caption: 'A caption' } };
    case 'cta':
      return { ...base, data: { heading: 'Act now', subheading: 'Because', label: 'Start', url: 'https://example.com/start' } };
    case 'columns':
      return { ...base, data: { heading: 'Cols', layout: 'cards', columns: [{ title: 'C1', text: 'T1', href: '/p/one' }, { title: 'C2', text: 'T2' }] } };
    case 'productGrid':
      return { ...base, data: { heading: 'Shop', storeOrgId: 'org-1', productIds: ['p1'] } };
    case 'form':
      return { ...base, data: { heading: 'Contact', formId: 'form-1' } };
    case 'pricing':
      return { ...base, data: { heading: 'Plans', blurb: 'All the **essentials**', tiers: ['free', 'pro'], ctaLabel: 'See pricing', ctaUrl: '/pricing' } };
    // ADR 0407 — entity-backed sections degrade to their own chrome (the
    // productGrid/form class); rows resolve client-side only.
    case 'entityList':
      return { ...base, data: { heading: 'Team', tenantId: 'tenant-1', typeName: 'team-member', titleField: 'name', limit: 6 } };
    case 'entityDetail':
      return { ...base, data: { heading: 'Spotlight', tenantId: 'tenant-1', typeName: 'team-member', entityId: 'e1', titleField: 'name' } };
    // ADR 0485 — a capability comparison matrix renders as a semantic <table>.
    case 'comparison':
      return { ...base, data: { heading: 'Compare', columns: ['OpenWOP', 'n8n'], rows: [{ label: 'Replay + fork', cells: ['Y', 'N'] }], highlightColumn: 0, legend: 'Y ships, N no', note: 'As of mid-2026.' } };
    // R2-G10 — authored Q/A (native disclosure; FAQPage JSON-LD rides jsonLdBlocks).
    case 'faq':
      return { ...base, data: { heading: 'FAQ', items: [{ q: 'How is pricing calculated?', a: 'Per workspace, flat.' }] } };
    // R2-G10 — attributed social proof.
    case 'quotes':
      return { ...base, data: { heading: 'Loved by teams', items: [{ quote: 'It shipped our launch.', name: 'Ana', role: 'CTO at Acme' }] } };
    // ADR 0748 — protocol-authored flat fields: a definition list, all text escaped.
    case 'fields':
      return { ...base, data: { heading: '<b>Plain</b>', seats: 3 } };
  }
}

describe('ADR 0384 sectionHtml — coverage', () => {
  it('renders EVERY SECTION_TYPES entry (drift gate: add a server branch with the CMS type)', () => {
    for (const type of SECTION_TYPES) {
      const html = sectionHtml(fixture(type), OPTS);
      expect(html, `sectionHtml must handle section type "${type}"`).not.toBeNull();
      expect(html).toContain('<');
    }
  });

  it('returns null for an unknown/future type → page-level SPA fallback', () => {
    const bogus = { sectionId: 's', type: 'holo-deck', data: {} } as unknown as Section;
    expect(sectionHtml(bogus, OPTS)).toBeNull();
    expect(pageBodyHtml([fixture('hero'), bogus], OPTS)).toBeNull();
  });
});

describe('ADR 0384 sectionHtml — golden fixture', () => {
  it('full-page golden (reconcile deliberately on any semantic change)', () => {
    const body = pageBodyHtml(SECTION_TYPES.map((t) => fixture(t)), OPTS);
    expect(body).toBe(`<main>
<header>
<p>Eyebrow</p>
<h1>Hero heading</h1>
<p>Sub with <strong>bold</strong></p>
<p><a href="/p/next">Go</a> <a href="https://example.com/d" rel="noopener noreferrer">Docs</a></p>
</header>
<section>
<h2 id="rich">Rich</h2>
<p>Para one with <em>em</em> and <code>code</code>.</p>
<p>Para two with <a href="https://example.com" rel="noopener noreferrer">link</a>.</p>
</section>
<figure>
<img src="https://app.example.test/host/openwop-app/assets/tok-abc" alt="An alt">
<figcaption>A caption</figcaption>
</figure>
<section>
<h2 id="act-now">Act now</h2>
<p>Because</p>
<p><a href="https://example.com/start" rel="noopener noreferrer">Start</a></p>
</section>
<section>
<h2 id="cols">Cols</h2>
<ul>
<li><a href="/p/one"><h3>C1</h3><p>T1</p></a></li>
<li><h3>C2</h3><p>T2</p></li>
</ul>
</section>
<section>
<h2 id="shop">Shop</h2>
<p><a href="/store/org-1">Shop</a></p>
</section>
<section>
<h2 id="contact">Contact</h2>
</section>
<section>
<h2 id="plans">Plans</h2>
<p>All the <strong>essentials</strong></p>
<p><a href="/pricing">See pricing</a></p>
</section>
<section>
<h2 id="team">Team</h2>
</section>
<section>
<h2 id="spotlight">Spotlight</h2>
</section>
<section>
<h2 id="compare">Compare</h2>
<table>
<thead><tr><td></td><th scope="col">OpenWOP</th><th scope="col">n8n</th></tr></thead>
<tbody>
<tr><th scope="row">Replay + fork</th><td>Y</td><td>N</td></tr>
</tbody>
</table>
<p>Y ships, N no</p>
<p>As of mid-2026.</p>
</section>
<section>
<h2 id="faq">FAQ</h2>
<details><summary>How is pricing calculated?</summary><p>Per workspace, flat.</p></details>
</section>
<section>
<h2 id="loved-by-teams">Loved by teams</h2>
<figure><blockquote><p>It shipped our launch.</p></blockquote><figcaption>Ana, CTO at Acme</figcaption></figure>
</section>
<section>
<dl><dt>heading</dt><dd>&lt;b&gt;Plain&lt;/b&gt;</dd><dt>seats</dt><dd>3</dd></dl>
</section>
</main>`);
  });

  it('columns layouts: steps → <ol>, stats → <dl>', () => {
    const steps = sectionHtml({ sectionId: 's', type: 'columns', data: { heading: 'How', layout: 'steps', columns: [{ title: 'A', text: 'a' }] } } as Section, OPTS);
    expect(steps).toContain('<ol>');
    expect(steps).toContain('01. <h3>A</h3>');
    const stats = sectionHtml({ sectionId: 's', type: 'columns', data: { layout: 'stats', columns: [{ title: '42', text: 'answers' }] } } as Section, OPTS);
    expect(stats).toContain('<dl>');
    expect(stats).toContain('<dt>42</dt><dd>answers</dd>');
  });
});

describe('ADR 0384 sectionHtml — safety', () => {
  it('escapes HTML in every text position (no raw pass-through)', () => {
    const html = sectionHtml({ sectionId: 's', type: 'hero', data: { heading: '<script>alert(1)</script>', subheading: 'x' } } as Section, OPTS);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('unsafe link degrades to plain text (same predicate as the SPA)', () => {
    // The shared regex ends the URL at the first `)`, so the outer paren stays
    // as literal text — byte-identical to the SPA grammar (parity, not a bug).
    expect(inlineMarkdownHtml('[x](javascript:alert(1))')).toBe('x)');
    expect(inlineMarkdownHtml('[x](vbscript:evil)')).toBe('x');
    expect(inlineMarkdownHtml('[x](//evil.example)')).toBe('x');
    expect(inlineMarkdownHtml('[x](/ok)')).toBe('<a href="/ok">x</a>');
    expect(inlineMarkdownHtml('[x](https://ok.example)')).toBe('<a href="https://ok.example" rel="noopener noreferrer">x</a>');
  });

  it('escapeHtml covers the five metacharacters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('CTA with unusable URL degrades to the escaped label', () => {
    const html = sectionHtml({ sectionId: 's', type: 'cta', data: { label: 'Click <b>me</b>', url: 'javascript:x' } } as Section, OPTS);
    expect(html).not.toContain('<a ');
    expect(html).toContain('Click &lt;b&gt;me&lt;/b&gt;');
  });
});
