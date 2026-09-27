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
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
vi.mock('../../../i18n/useFormat.js', () => ({ useFormat: () => ({ currency: (n: number) => String(n) }) }));

import { RenderSection } from '../SectionRenderer.js';

const ENTITY_SECTION = {
  type: 'entityList',
  data: { tenantId: 't1', typeName: 'article', titleField: 'title', limit: 10 },
} as never;

const PRODUCT_SECTION = {
  type: 'productGrid',
  data: { storeOrgId: 'org1', productIds: ['p1'] },
} as never;

const renderSection = async (section: unknown) => {
  await act(async () => {
    render(<RenderSection section={section as never} mode="public" />);
  });
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

describe('public entityList — a failed read must not delete the section', () => {
  it('says the section could not load instead of rendering nothing', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    await renderSection(ENTITY_SECTION);
    expect(screen.getByText(/Couldn’t load this section/i)).toBeTruthy();
  });

  it('SABOTAGE — a genuine empty result still renders nothing', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ entities: [] }),
    });
    await renderSection(ENTITY_SECTION);
    expect(screen.queryByText(/Couldn’t load this section/i)).toBeNull();
    expect(screen.queryByText(/Couldn’t load/i)).toBeNull();
  });

  it('a non-2xx is a failure, not an empty list', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await renderSection(ENTITY_SECTION);
    expect(screen.getByText(/Couldn’t load this section/i)).toBeTruthy();
  });
});

describe('public productGrid — a failed read must not delete the grid or its CTAs', () => {
  it('says the products could not load instead of rendering nothing', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    await renderSection(PRODUCT_SECTION);
    expect(screen.getByText(/Couldn’t load these products/i)).toBeTruthy();
  });

  it('SABOTAGE — a genuine empty result still renders nothing', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ products: [] }),
    });
    await renderSection(PRODUCT_SECTION);
    expect(screen.queryByText(/Couldn’t load these products/i)).toBeNull();
    expect(document.body.textContent?.trim()).toBe('');
  });
});
