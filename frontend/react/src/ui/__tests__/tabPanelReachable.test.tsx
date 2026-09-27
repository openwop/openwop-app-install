/**
 * `CSCU-2` — a tabpanel must be reachable by keyboard.
 *
 * `TabPanel` is a SHARED primitive behind 11 console pages. Without `tabIndex`, a panel
 * whose content holds no focusable element (a chart, a read-only table, an empty state)
 * can be seen and never reached or scrolled with the keyboard.
 *
 * The second half of the filed row — move focus INTO the panel on a tab click — is
 * deliberately refused, and that refusal is pinned: this tablist activates on arrow-key
 * focus, so focus belongs on the selected tab. A test asserting the tab keeps focus is
 * what stops a later "consistency" change from making mouse and keyboard disagree.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { Tabs, TabPanel } from '../Tabs.js';

afterEach(cleanup);

describe('CSCU-2 — the tabpanel is keyboard-reachable', () => {
  it('carries tabIndex=0 so a panel with no focusable content can still be reached', () => {
    render(<TabPanel idBase="x" tabId="one"><p>read-only content, nothing focusable</p></TabPanel>);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('tabindex'), 'a panel with no focusable child is otherwise unreachable').toBe('0');
    panel.focus();
    expect(document.activeElement).toBe(panel);
  });

  it('stays labelled by its tab (the pairing the primitive exists for)', () => {
    render(<TabPanel idBase="x" tabId="one"><p>c</p></TabPanel>);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('x-tab-one');
  });
});

describe('CSCU-2 (refused half) — clicking a tab leaves focus ON the tab', () => {
  it('does not yank focus into the panel, so mouse and keyboard activation agree', () => {
    const onChange = vi.fn();
    render(
      <>
        <Tabs
          idBase="x"
          value="one"
          onChange={onChange}
          items={[{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]}
          label="Console sections"
        />
        <TabPanel idBase="x" tabId="one"><p>c</p></TabPanel>
      </>,
    );
    const second = screen.getByRole('tab', { name: 'Two' });
    second.focus();
    fireEvent.click(second);
    expect(onChange).toHaveBeenCalledWith('two');
    expect(document.activeElement, 'focus belongs on the selected tab, not the panel').toBe(second);
  });
});
