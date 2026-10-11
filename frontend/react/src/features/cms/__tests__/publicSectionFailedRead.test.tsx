/**
 * PUBLIC-SITE content drops (ADR 0027 `mode="public"`).
 *
 * `EntityListSection` and `ProductGridSection` render on the anonymous public
 * site. Both collapsed a FAILED read into `setX([])` and then returned `null`
 * for `length === 0` — so a 500, a network blip, or a cold backend silently
 * DELETED a configured section from a live published page. The visitor saw a
 * short page; the operator saw nothing at all. The product grid took its
 * "Shop" CTAs with it, so the failure mode was revenue-facing and invisible.
 *
 * These sections were classified NEUTRAL by a copy-only triage — they make no
 * false statement — which is exactly why they needed catching separately: the
 * defect is the ABSENCE, not the wording.
 *
 * The empty case must keep rendering nothing: a section that legitimately
 * matches no rows should stay silent, and these tests pin that too.
 *
 * Incident: #2926 (afc9c04d6). Sabotage-witnessed (/grade-tests w17): a
 * `.catch` that sets `error` false reds the failed-read cases; dropping the
 * `!r.ok` throw reds the non-2xx case; a success path that sets `error` true
 * reds the empty cases.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ currency: (n: number) => String(n) }) }));

import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

const ENTITY_SECTION: Section = {
  sectionId: 'sec:list', type: 'entityList',
  data: { tenantId: 't1', typeName: 'article', titleField: 'title', limit: 10 },
};

const PRODUCT_SECTION: Section = {
  sectionId: 'sec:grid', type: 'productGrid',
  data: { storeOrgId: 'org1', productIds: ['p1'] },
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

let fetchMock = vi.fn<typeof fetch>();

const renderSection = async (section: Section) => {
  await act(async () => {
    render(<RenderSection section={section} mode="public" />);
  });
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock); });

describe('public entityList — a failed read must not delete the section', () => {
  it('says the section could not load instead of rendering nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderSection(ENTITY_SECTION);
    expect(screen.getByText(/Couldn’t load this section/i)).toBeTruthy();
  });

  it('SABOTAGE — a genuine empty result still renders nothing', async () => {
    fetchMock.mockResolvedValue(json({ entities: [] }));
    await renderSection(ENTITY_SECTION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Couldn’t load/i)).toBeNull();
    expect(document.body.textContent?.trim()).toBe('');
  });

  it('a non-2xx is a failure, not an empty list', async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    await renderSection(ENTITY_SECTION);
    expect(screen.getByText(/Couldn’t load this section/i)).toBeTruthy();
  });
});

describe('public productGrid — a failed read must not delete the grid or its CTAs', () => {
  it('says the products could not load instead of rendering nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderSection(PRODUCT_SECTION);
    expect(screen.getByText(/Couldn’t load these products/i)).toBeTruthy();
  });

  it('SABOTAGE — a genuine empty product list still renders nothing', async () => {
    fetchMock.mockResolvedValue(json({ products: [] }));
    await renderSection(PRODUCT_SECTION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Couldn’t load these products/i)).toBeNull();
    expect(document.body.textContent?.trim()).toBe('');
  });
});
