/**
 * Phase 0 authority parity (CommandPalette.tsx:111-114): the palette's
 * admin-only quick actions ("Create a run", "Compare runs", "Re-seed example
 * data") follow the RESOLVED admin nav projection — a non-empty `admin` group
 * is the same authority decision the rail makes. What breaks if this fails: a
 * non-admin is offered admin verbs (whose pages would 403), or an admin loses
 * them. Asserted on the REAL catalog labels (`i18n/locales/en/ui.ts`), by
 * option name, in BOTH directions.
 *
 * No `useEffectiveAccess` mock: the palette does not read it (its gate is the
 * projection), and nothing on the rendered path calls it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BoxesIcon } from '../icons/index.js';
import { CommandPalette } from '../CommandPalette.js';
import type { ResolvedNav } from '../../chrome/navConfig/resolveNav.js';

const nav = vi.hoisted((): { admin: ResolvedNav['admin'] } => ({ admin: [] }));
vi.mock('../../chrome/navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ workspace: [], admin: nav.admin, site: [], degraded: false }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));

afterEach(() => {
  cleanup();
  nav.admin = [];
});

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
});

const ADMIN_ONLY = ['Create a run', 'Compare runs', 'Re-seed example data'];

describe('CommandPalette authority projection', () => {
  it('keeps workspace actions and removes admin-only shortcuts for a non-admin', () => {
    render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('option', { name: /New agent/ })).toBeTruthy();
    for (const label of ADMIN_ONLY) {
      expect(screen.queryByRole('option', { name: new RegExp(label) })).toBeNull();
    }
  });

  it('offers the admin-only shortcuts when the resolved admin projection is non-empty', () => {
    nav.admin = [{ id: 'admin', label: 'Admin', items: [{ group: 'admin', to: '/admin', icon: BoxesIcon, label: 'Admin home', hint: '' }] }];
    render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);

    expect(screen.getByRole('option', { name: /New agent/ })).toBeTruthy();
    for (const label of ADMIN_ONLY) {
      expect(screen.getByRole('option', { name: new RegExp(label) })).toBeTruthy();
    }
  });
});
