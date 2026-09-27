/**
 * Phase 0 authority parity: navigation is filtered by useResolvedNav and
 * action-only shortcuts must honor the same admin boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from '../CommandPalette.js';

vi.mock('../../chrome/navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ workspace: [], admin: [], site: [], degraded: false }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));
vi.mock('../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccess: () => ({ roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }),
  isAdminCaller: () => false,
}));

afterEach(cleanup);

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
});

describe('CommandPalette authority projection', () => {
  it('keeps workspace actions and removes admin-only shortcuts for a non-admin', () => {
    render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.body.textContent).toMatch(/new agent/i);
    expect(document.body.textContent).not.toMatch(/new run/i);
    expect(document.body.textContent).not.toMatch(/compare runs/i);
    expect(document.body.textContent).not.toMatch(/reseed/i);
  });
});
