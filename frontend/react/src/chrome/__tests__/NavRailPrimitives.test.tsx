/**
 * Shared nav-rail primitives (ADR 0510 — one section/item renderer for the
 * workspace Sidebar and the admin rail). Guards what assistive technology sees:
 * the section disclosure state (aria-expanded) and a collapsed list leaving the
 * tree, the lock's localized accessible name, the badge, and the destination
 * name surviving compact (icon-only) mode. The `sr-only` class read is the only
 * jsdom-observable signal that the compact label is visually hidden (ceiling).
 */
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
    expect(screen.queryByRole('img', { name: 'Restricted' })).toBeNull();
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
