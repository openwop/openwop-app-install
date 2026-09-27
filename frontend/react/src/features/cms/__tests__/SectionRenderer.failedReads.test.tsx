/**
 * UX_UPGRADE-site ROUND 2 (R2-G4) — the two public sections whose failed read
 * still rendered as "nothing there": `entityDetail` (the one sibling the
 * failed-read sweep missed — SITE-R2-3) and the pricing add-on bundles (a
 * revenue surface — READ-1). A failed read renders the designed note; a genuine
 * 404 stays silent (the positive case, or the fix degrades into always-error).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DETAIL: Section = {
  sectionId: 'e1', type: 'entityDetail',
  data: { tenantId: 'org-1', typeName: 'caseStudy', entityId: 'cs-1', titleField: 'name' },
};

function renderSection(section: Section) {
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
}

describe('entityDetail — failed ≠ missing (SITE-R2-3)', () => {
  it('renders the designed section-load note when the read FAILS', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    renderSection(DETAIL);
    await screen.findByText('Couldn’t load this section.');
  });

  it('stays silent on a genuine 404 (the positive case)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response));
    renderSection(DETAIL);
    // Give the fetch a tick to settle, then assert the note did NOT appear.
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Couldn’t load this section.')).toBeNull();
  });

  it('renders the entity when the read succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ entityId: 'cs-1', values: { name: 'Acme case study' } }),
    }) as Response));
    renderSection(DETAIL);
    await screen.findByText('Acme case study');
  });
});

describe('pricing add-on bundles — failed ≠ none configured (READ-1)', () => {
  const PRICING: Section = { sectionId: 'p1', type: 'pricing', data: { heading: 'Plans' } };

  it('says the bundles could not load while the tier grid still renders', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/public/bundle-pricing')) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ tiers: [{ tier: 'free', name: 'Free', features: [] }] }) } as Response;
    }));
    renderSection(PRICING);
    await screen.findByText('Free');
    await screen.findByText('Couldn’t load add-on bundles.');
  });

  it('stays silent when bundles are genuinely unconfigured (404 or empty)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/public/bundle-pricing')) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ tiers: [{ tier: 'free', name: 'Free', features: [] }] }) } as Response;
    }));
    renderSection(PRICING);
    await screen.findByText('Free');
    expect(screen.queryByText('Couldn’t load add-on bundles.')).toBeNull();
  });
});
