/**
 * ui/Tabs `TabItem.meta` (ADR 0864) — a status after the label that is part of
 * the tab's accessible name, after a spoken comma, so a screen reader hears
 * "Connections, 1 issue" rather than "Connections1 issue". (jsdom inserts a space
 * before the comma that browsers do not; the matchers allow either.)
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tabs } from '../Tabs.js';

describe('Tabs — meta', () => {
  it('names the tab with its status, separated by a hidden comma', () => {
    render(
      <Tabs
        items={[
          { id: 'keys', label: 'Keys', meta: '2' },
          { id: 'connections', label: 'Connections', meta: '1 issue', metaTone: 'attention' },
          { id: 'endpoints', label: 'Endpoints' },
        ]}
        value="keys"
        onChange={() => {}}
        orientation="vertical"
      />,
    );
    expect(screen.getByRole('tab', { name: /^Connections\s*, 1 issue$/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Keys\s*, 2$/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Endpoints$/ })).toBeTruthy();
    const meta = screen.getByRole('tab', { name: /^Connections\s*, 1 issue$/ }).querySelector('.tab__meta');
    expect(meta?.className).toContain('tab__meta--attention');
    expect(screen.getByRole('tab', { name: /^Keys\s*, 2$/ }).querySelector('.tab__meta')?.className).toBe('tab__meta');
  });
});
