/**
 * UX_UPGRADE-funnels ROUND 3 — FN-B-8, deferred in R2 as "server lock already
 * correct; needs its own edit surface". This IS that surface: a per-step name
 * input in the builder. The pins are behavioural — what `updateFunnel` is
 * CALLED WITH — and the clear path is pinned explicitly (empty input ⇒ the
 * step payload carries NO `name` key, so the server's absent-clears semantics
 * fire; the creative-briefs R2 lesson — a "clear" that ships the old value
 * re-arms forever).
 *
 * The write is asserted whole: org, funnel and the full `steps` array, so a save
 * that targets the wrong funnel or drops/rewrites the untouched step is red too.
 *
 * Sabotage-witnessed (wave 52): dropping the renamed value from the edit state,
 * sending `name: ''` instead of removing the key, seeding an unnamed step with
 * `name: ''`, saving the ORIGINAL steps instead of the edited ones, and rendering
 * the kind label as the input's value each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as FC from '../funnelsClient.js';
import type { Funnel, FunnelStats } from '../funnelsClient.js';
import type * as CC from '../../cms/cmsClient.js';
import type { Page } from '../../cms/cmsClient.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof FC.listOrgs>(),
  getFunnel: vi.fn<typeof FC.getFunnel>(),
  getFunnelStats: vi.fn<typeof FC.getFunnelStats>(async (): Promise<FunnelStats> => ({ funnelId: 'f1', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
  deleteFunnel: vi.fn<typeof FC.deleteFunnel>(),
  updateFunnel: vi.fn<typeof FC.updateFunnel>(),
}));
vi.mock('../funnelsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const cms = vi.hoisted(() => ({ listPages: vi.fn<typeof CC.listPages>() }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...cms };
});

const { FunnelDetailPage } = await import('../FunnelDetailPage.js');

/** The steps array the page SENT (the typed mock's third argument). */
const sentSteps = (): NonNullable<Parameters<typeof FC.updateFunnel>[2]['steps']> =>
  api.updateFunnel.mock.calls[0]![2].steps ?? [];

const FUNNEL: Funnel = {
  funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch',
  status: 'draft',
  steps: [
    { stepId: 's1', kind: 'landing', pageId: 'p1', name: 'Warm welcome' },
    { stepId: 's2', kind: 'thankyou', pageId: 'p1' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const LANDING: Page = {
  pageId: 'p1', title: 'Landing', slug: 'landing', status: 'published', sections: [],
  version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
};

const view = (): void => {
  render(
    <MemoryRouter initialEntries={['/funnels/f1']}>
      <Routes><Route path="/funnels/:funnelId" element={<FunnelDetailPage />} /></Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  api.getFunnel.mockResolvedValue(FUNNEL);
  api.updateFunnel.mockResolvedValue(FUNNEL);
  cms.listPages.mockResolvedValue([LANDING]);
});
afterEach(cleanup);

describe('FN-B-8 — the step-rename edit surface', () => {
  it('renders each step\'s current name, and saves a rename through updateFunnel', async () => {
    view();
    const first = await screen.findByRole('textbox', { name: /name for step 1/i });
    expect((first as HTMLInputElement).value).toBe('Warm welcome');
    // An unnamed step shows its kind as the PLACEHOLDER, never as a value —
    // saving untouched must not bake the fallback label into the model.
    const second = screen.getByRole('textbox', { name: /name for step 2/i });
    expect((second as HTMLInputElement).value).toBe('');

    fireEvent.change(first, { target: { value: 'Hero pitch' } });
    fireEvent.click(screen.getByRole('button', { name: /save steps/i }));

    await waitFor(() => expect(api.updateFunnel).toHaveBeenCalled());
    expect(api.updateFunnel).toHaveBeenCalledTimes(1);
    expect(api.updateFunnel).toHaveBeenCalledWith('o1', 'f1', {
      steps: [
        { stepId: 's1', kind: 'landing', pageId: 'p1', name: 'Hero pitch' },
        { stepId: 's2', kind: 'thankyou', pageId: 'p1' },
      ],
    });
    // `toHaveBeenCalledWith` ignores an `undefined` key; the untouched step must carry none.
    expect(sentSteps()[1]).not.toHaveProperty('name');
  });

  it('an emptied name is CLEARED from the payload, not sent as ""', async () => {
    view();
    const first = await screen.findByRole('textbox', { name: /name for step 1/i });
    fireEvent.change(first, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save steps/i }));

    await waitFor(() => expect(api.updateFunnel).toHaveBeenCalled());
    // The explicit-clear pin: no `name` key at all ⇒ the server's
    // absent-clears sanitize fires; `name: ''` would instead persist an
    // empty-string label into every picker and the stats table.
    expect(sentSteps()[0]).not.toHaveProperty('name');
    expect(sentSteps()[0]).toEqual({ stepId: 's1', kind: 'landing', pageId: 'p1' });
  });

  it('the unnamed step stays unnamed through an unrelated save (negative control)', async () => {
    view();
    await screen.findByRole('textbox', { name: /name for step 1/i });
    fireEvent.click(screen.getByRole('button', { name: /save steps/i }));
    await waitFor(() => expect(api.updateFunnel).toHaveBeenCalled());
    expect(sentSteps()[1]).not.toHaveProperty('name');
  });
});
