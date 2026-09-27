/**
 * UX_UPGRADE-docs R2-D12 — the section→markdown projection's drift gate.
 *
 * Same discipline as `adr0384-section-html.test.ts`: every entry in the closed
 * SECTION_TYPES vocabulary MUST render (a new CMS type without a markdown
 * branch is a red build), unknown type ⇒ null (the route then 404s — never a
 * partial document), and the shapes that carry structure (comparison table,
 * faq headings, quote attribution) are pinned.
 */
import { describe, expect, it } from 'vitest';
import { SECTION_TYPES, type Section } from '../src/features/cms/cmsService.js';
import { pageMarkdown, sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const BASE = 'https://app.example.test';

/** A minimal renderable section per type (mirrors the sectionHtml fixtures). */
function fixture(type: Section['type']): Section {
  const base = { sectionId: `sec-${type}`, type } as const;
  switch (type) {
    case 'hero': return { ...base, data: { heading: 'Hero', subheading: 'Sub', ctaLabel: 'Go', ctaUrl: '/p/next' } };
    case 'richText': return { ...base, data: { heading: 'Rich', text: 'Para one.' } };
    case 'image': return { ...base, data: { token: 'tok-abc', alt: 'An alt', caption: 'A caption' } };
    case 'cta': return { ...base, data: { heading: 'Act', label: 'Start', url: 'https://example.com/s' } };
    case 'columns': return { ...base, data: { heading: 'Cols', layout: 'steps', columns: [{ title: 'A', text: 'a' }, { title: 'B', text: 'b' }] } };
    case 'productGrid': return { ...base, data: { heading: 'Shop', storeOrgId: 'org-1', productIds: ['p1'] } };
    case 'form': return { ...base, data: { heading: 'Contact', formId: 'form-1' } };
    case 'pricing': return { ...base, data: { heading: 'Plans', blurb: 'Essentials', ctaLabel: 'See', ctaUrl: '/pricing' } };
    case 'entityList': return { ...base, data: { heading: 'Team', tenantId: 't', typeName: 'x', titleField: 'name', limit: 6 } };
    case 'entityDetail': return { ...base, data: { heading: 'Spotlight', tenantId: 't', typeName: 'x', entityId: 'e1', titleField: 'name' } };
    case 'comparison': return { ...base, data: { heading: 'Compare', columns: ['Us', 'Them'], rows: [{ label: 'Replay', cells: ['Y', 'N'] }] } };
    case 'faq': return { ...base, data: { heading: 'FAQ', items: [{ q: 'Why?', a: 'Because.' }] } };
    case 'quotes': return { ...base, data: { items: [{ quote: 'Great.', name: 'Ana', role: 'CTO' }, { quote: 'Anon.' }] } };
    case 'fields': return { ...base, data: { heading: 'Plain', seats: 3 } };
  }
}

describe('sectionMarkdown — coverage (drift gate)', () => {
  it('renders EVERY SECTION_TYPES entry (add a markdown branch with the CMS type)', () => {
    for (const type of SECTION_TYPES) {
      const md = sectionMarkdown(fixture(type), BASE);
      expect(md, `sectionMarkdown must handle section type "${type}"`).not.toBeNull();
    }
  });

  it('returns null for an unknown/future type → the route 404s', () => {
    const bogus = { sectionId: 's', type: 'holo-deck', data: {} } as unknown as Section;
    expect(sectionMarkdown(bogus, BASE)).toBeNull();
    expect(pageMarkdown({ title: 'T', updatedAt: '2026-08-01T00:00:00.000Z', sections: [bogus] }, BASE)).toBeNull();
  });
});

describe('sectionMarkdown — structural shapes', () => {
  it('comparison renders a real markdown table', () => {
    const md = sectionMarkdown(fixture('comparison'), BASE)!;
    expect(md).toContain('| | Us | Them |');
    expect(md).toContain('| Replay | Y | N |');
  });

  it('faq renders one heading per question; quotes attribute ONLY when authored', () => {
    expect(sectionMarkdown(fixture('faq'), BASE)).toContain('### Why?\n\nBecause.');
    const q = sectionMarkdown(fixture('quotes'), BASE)!;
    expect(q).toContain('> Great.\n>\n> — Ana, CTO');
    expect(q).toContain('> Anon.');
    expect(q).not.toContain('> Anon.\n>\n> —');
  });

  it('pageMarkdown stitches title + freshness + sections into one document', () => {
    const md = pageMarkdown({
      title: 'The Guide', updatedAt: '2026-08-01T12:00:00.000Z',
      sections: [fixture('richText')],
    }, BASE)!;
    expect(md.startsWith('# The Guide\n')).toBe(true);
    expect(md).toContain('*Updated 2026-08-01*');
    expect(md).toContain('## Rich');
    expect(md).toContain('Para one.');
  });
});
