import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsIcon } from '../../ui/icons/index.js';
import { NavRailItemContent, NavRailSection } from '../NavRailPrimitives.js';

afterEach(cleanup);

describe('shared navigation rail primitives', () => {
  it('exposes section disclosure state and removes a collapsed list from navigation order', () => {
    const { rerender } = render(<NavRailSection classPrefix="admin-nav" title="Security" showHeader collapsed={false} onToggle={() => undefined}><li>Capabilities</li></NavRailSection>);
    expect(screen.getByRole('button', { name: 'Security' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list')).toBeTruthy();
    rerender(<NavRailSection classPrefix="admin-nav" title="Security" showHeader collapsed onToggle={() => undefined}><li>Capabilities</li></NavRailSection>);
    expect(screen.getByRole('button', { name: 'Security' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders localized lock metadata or a badge, and suppresses both in compact mode', () => {
    const { rerender } = render(<NavRailItemContent classPrefix="admin-nav" icon={<SettingsIcon />} label="Settings" locked lockedLabel="Restricted" compact={false} />);
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Restricted' })).toBeTruthy();
    rerender(<NavRailItemContent classPrefix="admin-nav" icon={<SettingsIcon />} label="Settings" locked={false} lockedLabel="Restricted" badge="Beta" compact={false} />);
    expect(screen.getByText('Beta')).toBeTruthy();
    rerender(<NavRailItemContent classPrefix="admin-nav" icon={<SettingsIcon />} label="Settings" locked lockedLabel="Restricted" badge="Beta" compact />);
    expect(screen.queryByRole('img', { name: 'Restricted' })).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('keeps a compact destination label available to assistive technology', () => {
    render(<a href="/settings"><NavRailItemContent classPrefix="admin-nav" icon={<SettingsIcon />} label="Settings" locked={false} lockedLabel="Restricted" compact /></a>);
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('Settings').className).toBe('sr-only');
  });
});
