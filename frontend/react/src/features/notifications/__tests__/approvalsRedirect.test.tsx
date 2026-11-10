/**
 * NYI-EMAIL-1 — email send-approval notifications delivered before #5504 carry
 * `actionUrl: '/approvals'`, which was never a route. Notifications are stored, so the old
 * link outlives the fix; the `/approvals` shim must land on the inbox, not "Page not found".
 *
 * The second case also pins `tier: 'workspace'`. The tier is what actually mounts the shim:
 * App.tsx mounts only `FEATURES.filter((f) => f.tier === 'workspace')` into the workspace
 * routes, and the first case mounts the shim in its own `<Routes>`.
 *
 * Sabotage-witnessed (w85): deleting the `/approvals` route reds both cases (the catch-all
 * renders). Pointing it at another path reds the first. A `nav` entry or a non-workspace tier
 * reds the second.
 */
import type { JSX } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { notificationsFeature } from '../routes.js';

afterEach(cleanup);

function Where(): JSX.Element {
  return <p>at {useLocation().pathname}</p>;
}

describe('/approvals redirect shim', () => {
  it('an old /approvals link lands on /inbox', () => {
    const shim = notificationsFeature.routes.find((r) => r.path === '/approvals');
    render(
      <MemoryRouter initialEntries={['/approvals']}>
        <Routes>
          {shim ? <Route path={shim.path} element={shim.element} /> : null}
          <Route path="/inbox" element={<Where />} />
          <Route path="*" element={<p>not found</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('at /inbox')).toBeTruthy();
  });

  it('is a shim, not a menu destination', () => {
    const shim = notificationsFeature.routes.find((r) => r.path === '/approvals');
    expect(shim?.tier).toBe('workspace');
    expect(shim?.nav).toBeUndefined();
  });
});
