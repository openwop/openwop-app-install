/** Phase 0: the overview is a rendering of the effective nav, not a second catalog. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsIcon } from '../../ui/icons/index.js';
import { AdminOverviewPage } from '../AdminOverviewPage.js';

vi.mock('../../chrome/navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({
    workspace: [], site: [], degraded: false,
    admin: [{
      id: 'custom-a', label: 'My operator tools', custom: true,
      items: [
        { to: '/admin', label: 'Overview', hint: 'Self', icon: SettingsIcon },
        { to: '/only-effective', label: 'Effective destination', hint: 'From the resolved projection', icon: SettingsIcon },
      ],
    }],
  }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));

afterEach(cleanup);

describe('AdminOverviewPage navigation parity', () => {
  it('renders the effective custom group and omits the overview self-link', () => {
    render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'My operator tools' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /effective destination/i }).getAttribute('href')).toBe('/only-effective');
    expect(screen.queryByRole('link', { name: /overview/i })).toBeNull();
  });
});
