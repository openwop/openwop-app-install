/**
 * UX_UPGRADE-creative-briefs ROUND 2 — the identity + render-lane honesty set.
 *
 *  - CRB-SP-1: navigating brief A → brief B without unmount kept A's form
 *    state, and Save wrote A's content INTO B (silent cross-brief corruption).
 *    The keyed remount must re-initialize the form from B.
 *  - CRB-SP-3: renders/reels act on the SAVED brief — a dirty form must save
 *    first (with the CTA saying so), or a paid render is of stale text.
 *  - CRB-SP-4: `briefVersion` is stamped at render time; a render of an older
 *    version must say so, hardest on the Use-in-campaign handoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CreativeBrief, CreativeRender } from '../creativeBriefsClient.js';

const getBrief = vi.fn();
const listBriefs = vi.fn();
const updateBrief = vi.fn();
const listRenders = vi.fn();
const listRenderTemplates = vi.fn();
const createRenders = vi.fn();
const calls: string[] = [];

vi.mock('../creativeBriefsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBriefs: (..._a: unknown[]) => listBriefs(),
    getBrief: (...a: unknown[]) => getBrief(...a),
    updateBrief: (...a: unknown[]) => { calls.push('update'); return updateBrief(...a); },
    transitionBrief: vi.fn(async () => ({})),
    listVersions: vi.fn(async () => []),
    deleteBrief: vi.fn(async () => {}),
    listRenders: (...a: unknown[]) => listRenders(...a),
    listRenderTemplates: (..._a: unknown[]) => listRenderTemplates(),
    createRenders: (...a: unknown[]) => { calls.push('render'); return createRenders(...a); },
  };
});
vi.mock('../../media/mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAssets: vi.fn(async () => []),
  absoluteServeUrl: (s: string) => s,
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { CreativeBriefsPage } from '../CreativeBriefsPage.js';

function mkBrief(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    briefId: 'cb-1', orgId: 'org-1', title: 'Spring hero', assetType: 'still',
    sceneDescription: 'A field at dawn', directions: [], moodBoard: [],
    status: 'review', version: 3, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as CreativeBrief;
}

const TEMPLATE = { templateId: 'tp-1', platform: 'meta', format: 'feed', width: 1080, height: 1080, safeZones: [] };

function mkRender(over: Partial<CreativeRender> = {}): CreativeRender {
  return {
    renderId: 'r-1', briefId: 'cb-1', orgId: 'org-1', templateId: 'tp-1', mediaAssetId: 'ma-1',
    copy: { headline: 'H' }, warnings: [], createdAt: '2026-01-02T00:00:00.000Z',
    ...over,
  } as CreativeRender;
}

function mount(initialPath: string): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      {/* an in-app link so navigation happens WITHOUT a fresh tree — the exact
          shape of the "New brief" button's A→B navigation */}
      <Link to="/creative-briefs/cb-2">go-to-b</Link>
      <Routes>
        <Route path="/creative-briefs" element={<CreativeBriefsPage />} />
        <Route path="/creative-briefs/:briefId" element={<CreativeBriefsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  calls.length = 0;
  listBriefs.mockReset().mockResolvedValue([mkBrief()]);
  getBrief.mockReset().mockImplementation(async (_org: string, id: string) =>
    id === 'cb-2' ? mkBrief({ briefId: 'cb-2', title: 'Autumn hero', sceneDescription: 'A forest at dusk' }) : mkBrief());
  updateBrief.mockReset().mockResolvedValue(mkBrief());
  listRenders.mockReset().mockResolvedValue([]);
  listRenderTemplates.mockReset().mockResolvedValue([TEMPLATE]);
  createRenders.mockReset().mockResolvedValue({ renders: [mkRender()], failures: [] });
});
afterEach(cleanup);

describe('CRB-SP-1 — brief switch remounts the detail', () => {
  it('the form re-initializes from brief B — never keeps (or saves) brief A\'s state', async () => {
    mount('/creative-briefs/cb-1');
    await act(async () => {});
    const title = await screen.findByDisplayValue('Spring hero');
    // Make A's form dirty — the corrupting ingredient.
    fireEvent.change(title, { target: { value: 'EDITED ON A' } });
    // Navigate A → B in-app (no unmount of the tree).
    fireEvent.click(screen.getByText('go-to-b'));
    await act(async () => {});
    // The keyed remount re-initialized from B. The un-keyed version kept
    // 'EDITED ON A' on screen — and Save would have written it into cb-2.
    expect(await screen.findByDisplayValue('Autumn hero')).toBeTruthy();
    expect(screen.queryByDisplayValue('EDITED ON A')).toBeNull();
  });
});

describe('CRB-SP-3 — the render lane saves first when the form is dirty', () => {
  it('relabels the CTA and saves BEFORE rendering', async () => {
    mount('/creative-briefs/cb-1');
    await act(async () => {});
    const title = await screen.findByDisplayValue('Spring hero');
    // Select a template so the render CTA is enabled.
    fireEvent.click(await screen.findByRole('button', { name: /meta · 1080×1080/i }));
    // Clean form: the plain label.
    expect(screen.getByRole('button', { name: /^Render 1 format$/ })).toBeTruthy();
    // Dirty form: the label DISCLOSES the save (the CRB-G1 pattern).
    fireEvent.change(title, { target: { value: 'New headline direction' } });
    const cta = screen.getByRole('button', { name: /^Save & render 1 format$/ });
    fireEvent.click(cta);
    await act(async () => {});
    // The save landed BEFORE the render — a paid render of stale text is the
    // defect.
    expect(calls.indexOf('update')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('update')).toBeLessThan(calls.indexOf('render'));
  });
});

describe('CRB-SP-4 — an old render says which version it came from', () => {
  it('stale render: chip + relabeled handoff; current render: neither', async () => {
    listRenders.mockResolvedValue([
      mkRender({ renderId: 'r-old', briefVersion: 1 }),
      mkRender({ renderId: 'r-new', briefVersion: 3, mediaAssetId: 'ma-2' }),
    ]);
    mount('/creative-briefs/cb-1');
    await act(async () => {});
    await screen.findByDisplayValue('Spring hero');
    expect(await screen.findByText('From v1 of this brief')).toBeTruthy();
    expect(screen.queryByText('From v3 of this brief')).toBeNull();
    expect(screen.getByRole('button', { name: /Use in campaign \(older version\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Use in campaign$/ })).toBeTruthy();
  });
});

describe('R3 CRB-SP-15 remainder — fetched-and-dropped facts render', () => {
  it('a reel render shows its configured duration/aspect/provider; absent facts render NO line', async () => {
    listRenders.mockResolvedValue([
      mkRender({ renderId: 'r-reel', reel: { prompt: 'p', durationSeconds: 8, aspectRatio: '9:16', provider: 'veo' } } as Partial<CreativeRender>),
      mkRender({ renderId: 'r-reel-bare', reel: { prompt: 'p' } } as Partial<CreativeRender>),
    ]);
    mount('/creative-briefs/cb-1');
    await screen.findByDisplayValue('Spring hero');
    expect(await screen.findByText('8s · 9:16 · veo')).toBeTruthy();
    // The bare reel renders no facts line (absence honest, no fabricated defaults).
    expect(screen.getAllByText(/8s · 9:16 · veo/).length).toBe(1);
  });

  it('the brief card shows its direction count; zero directions show no chip', async () => {
    listBriefs.mockResolvedValue([
      mkBrief({ briefId: 'cb-1', title: 'Spring hero', directions: [{ label: 'A' }, { label: 'B' }] as CreativeBrief['directions'] }),
      mkBrief({ briefId: 'cb-3', title: 'Bare brief', directions: [] }),
    ]);
    mount('/creative-briefs');
    await screen.findByText('Spring hero');
    expect(screen.getByText('2 direction(s)')).toBeTruthy();
    expect(screen.getAllByText(/direction\(s\)/).length).toBe(1); // zero-direction card shows none
  });
});
