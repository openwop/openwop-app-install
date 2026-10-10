/**
 * ui/Tabs `orientation="vertical"` + `TabItem.group` (the Access Hub side menu).
 *
 * The group label is drawn once per RUN of equal groups and is hidden from
 * assistive tech: a tablist may own only tabs, so the label must never be
 * announced as, or counted among, the tabs.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tabs } from '../Tabs.js';

const items = [
  { id: 'keys', label: 'Keys', group: 'Credentials' },
  { id: 'connections', label: 'Connections', group: 'Credentials' },
  { id: 'orgs', label: 'Organizations', group: 'Identity' },
];

describe('Tabs — vertical, grouped', () => {
  it('labels each group once, outside the accessibility tree', () => {
    const { container } = render(<Tabs items={items} value="keys" onChange={() => {}} orientation="vertical" idBase="t" />);
    const labels = Array.from(container.querySelectorAll('.tabs__group'));
    expect(labels.map((l) => l.textContent)).toEqual(['Credentials', 'Identity']);
    for (const l of labels) expect(l.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Keys', 'Connections', 'Organizations']);
  });

  it('places each label directly before the first tab of its group', () => {
    const { container } = render(<Tabs items={items} value="keys" onChange={() => {}} orientation="vertical" idBase="t" />);
    const identity = Array.from(container.querySelectorAll('.tabs__group'))[1];
    expect(identity?.nextElementSibling?.id).toBe('t-tab-orgs');
  });

  it('advertises its orientation; a horizontal strip does not', () => {
    const { rerender } = render(<Tabs items={items} value="keys" onChange={() => {}} orientation="vertical" />);
    expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.getByRole('tablist').className).toContain('tabs--vertical');
    rerender(<Tabs items={items} value="keys" onChange={() => {}} />);
    expect(screen.getByRole('tablist').hasAttribute('aria-orientation')).toBe(false);
    expect(screen.getByRole('tablist').className).toBe('tabs');
  });
});
