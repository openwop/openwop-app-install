/**
 * UX_UPGRADE-funnels ROUND 3 — FN-B-8, deferred in R2 as "server lock already
 * correct; needs its own edit surface". This IS that surface: a per-step name
 * input in the builder. The pins are behavioural — what `updateFunnel` is
 * CALLED WITH — and the clear path is pinned explicitly (empty input ⇒ the
 * step payload carries NO `name` key, so the server's absent-clears semantics
 * fire; the creative-briefs R2 lesson — a "clear" that ships the old value
 * re-arms forever).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  getFunnel: vi.fn(),
  getFunnelStats: vi.fn(async () => ({ funnelId: 'f1', steps: [], days: [], eventWindow: 30, rebuiltAt: null })),
  deleteFunnel: vi.fn(),
  updateFunnel: vi.fn(async () => FUNNEL),
}));
vi.mock('../funnelsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const cms = vi.hoisted(() => ({ listPages: vi.fn(async () => [{ pageId: 'p1', title: 'Landing', status: 'published' }]) }));
vi.mock('../../cms/cmsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...cms };
});

const { FunnelDetailPage } = await import('../FunnelDetailPage.js');

/** The steps array the page SENT — the mock's untyped tuple, cast once. */
const sentSteps = (): Array<Record<string, unknown>> =>
  (api.updateFunnel.mock.calls[0] as unknown as [string, string, { steps: Array<Record<string, unknown>> }])[2].steps;

const FUNNEL = {
  funnelId: 'f1', orgId: 'o1', name: 'Summer launch', slug: 'summer-launch',
  status: 'draft' as const,
  steps: [
    { stepId: 's1', kind: 'landing' as const, pageId: 'p1', name: 'Warm welcome' },
    { stepId: 's2', kind: 'thankyou' as const, pageId: 'p1' },
  ],
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
  api.updateFunnel.mockResolvedValue(FUNNEL as never);
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
    expect(sentSteps()[0]).toMatchObject({ stepId: 's1', name: 'Hero pitch' });
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
  });

  it('the unnamed step stays unnamed through an unrelated save (negative control)', async () => {
    view();
    await screen.findByRole('textbox', { name: /name for step 1/i });
    fireEvent.click(screen.getByRole('button', { name: /save steps/i }));
    await waitFor(() => expect(api.updateFunnel).toHaveBeenCalled());
    expect(sentSteps()[1]).not.toHaveProperty('name');
  });
});
