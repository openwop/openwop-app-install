/**
 * ADR 0419 — EntitlementGuard ROUTING. The guard decides, from `useFeatureAccess`,
 * whether to render the feature, a busy state, or the (lazy) locked panel. The
 * locked panel's own for-sale logic is tested in LockedState.test.tsx — kept
 * separate because the panel is `React.lazy` (to keep the marketplace client out of
 * the entry chunk), which does not settle cleanly under a jsdom render assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { makeFeatureAccess } from '../__testing__/makeFeatureAccess.js';

let state = { locked: false, loading: false };
vi.mock('../FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ ...state, enabled: true, entitled: !state.locked }),
}));

import { EntitlementGuard } from '../EntitlementGuard.js';

const view = () => render(
  <MemoryRouter><EntitlementGuard featureId="crm"><div>FEATURE CONTENT</div></EntitlementGuard></MemoryRouter>,
);
beforeEach(() => { state = { locked: false, loading: false }; });
afterEach(cleanup);

describe('EntitlementGuard routing (ADR 0419)', () => {
  it('renders the feature when not locked', () => {
    view();
    expect(screen.getByText('FEATURE CONTENT')).toBeTruthy();
  });

  it('does NOT render the feature when locked (defers to the locked panel)', () => {
    state = { locked: true, loading: false };
    view();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
    // The lazy locked panel loads behind a Suspense fallback; the invariant that
    // matters here is that feature content never leaks while locked.
  });

  it('does not flash the feature while access is resolving', () => {
    state = { locked: false, loading: true };
    view();
    expect(screen.queryByText('FEATURE CONTENT')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy(); // busy, announced
  });
});
