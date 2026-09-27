/**
 * NAV-G1 (UX_UPGRADE-navigation-settings, 2026-08-01) — the failed-load guard
 * existed but its comment claimed a test that did NOT exist anywhere in the
 * repo ("Tested above the loading card…"). This is that test.
 *
 * The guard matters because Save writes a FULL override set: presenting an
 * unread config as editable would let one Save wipe the tenant's real menu
 * config (the model-router destructive-write class). Both arms pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EMPTY_MENU_CONFIG_BUNDLE } from '../../../chrome/navConfig/types.js';

const nav = vi.hoisted(() => ({
  bundle: null as unknown,
  loading: false,
  failed: false,
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../chrome/navConfig/NavConfigProvider.js', () => ({
  useNavConfig: () => ({
    bundle: nav.bundle, loading: nav.loading, failed: nav.failed,
    saveTenant: vi.fn(), saveUser: vi.fn(),
  }),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false, status: 'on', isBeta: false, variant: null }),
}));
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccess: () => ({ roles: ['admin'], scopes: [], basis: 'member' }),
  isAdminCaller: () => true,
}));

import { MenuSettingsPage } from '../MenuSettingsPage.js';

const view = (): void => {
  render(<MemoryRouter><MenuSettingsPage /></MemoryRouter>);
};

beforeEach(() => { nav.bundle = EMPTY_MENU_CONFIG_BUNDLE; nav.loading = false; nav.failed = false; });
afterEach(cleanup);

describe('menu settings — failed-load guard (NAV-G1)', () => {
  it('a failed config read renders the failure card, never the editor (Save writes a full override set)', () => {
    nav.failed = true;
    view();
    expect(document.body.textContent).toMatch(/couldn.t load|could not load/i);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  // PRE-2 — this needs a longer timeout than the 5s default, and the reason is
  // MEASURED, not guessed: instrumenting the two phases separately gives
  // `import=1005ms render=91ms`. The cost is vitest transforming the editor subtree
  // on first import INSIDE the test body; the render itself is 91 milliseconds.
  // Under full-suite contention (transform aggregated to ~196s in one observed run)
  // the import alone clears 5s and the test times out.
  //
  // The sibling test above renders only a Notice, so it never pays this and always
  // passed — which is what made the failure look load-dependent and "flaky".
  //
  // §CORRECTION: I first filed this as a ~24-SECOND BLOCKING RENDER and a product
  // defect users meet as a frozen page, and explicitly warned against raising the
  // timeout. That was wrong. The 24.46s figure was vitest's aggregate for the FILE
  // (dominated by transform), not render work. Raising the timeout is the correct
  // fix here precisely because the render is fast — the measurement is what
  // distinguishes an honest timeout bump from papering over a freeze.
  it('a loaded config renders the editor with Save available', () => {
    nav.bundle = { ...EMPTY_MENU_CONFIG_BUNDLE, loadedFromServer: true } as never;
    view();
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  }, 30_000);
});
