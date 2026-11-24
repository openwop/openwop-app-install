/**
 * The command palette's Escape listener exists in the SAME commit that shows the
 * dialog, before paint (train 516's e2e red and DeckTalk's twice, 2026-11-24).
 *
 * The listener used to be a passive `useEffect`. On the lazy-mount open
 * (openSignal → setOpen in a passive effect, a default-priority commit) the
 * dialog painted before any listener existed, and a fast Escape was lost.
 *
 * This file renders OUTSIDE act(), so React schedules as it does in a browser.
 * It presses Escape on the microtask right after the commit that inserts the
 * dialog, which is before any passive effect can run. It must stay in its own
 * file. MEASURED: after an act()-based render earlier in the same file, passive
 * effects flushed before the microtask, and this case went green on the bug.
 *
 * Red when the listener is a `useEffect` again, or registered late
 * (`setTimeout`).
 */
import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
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

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
});

describe('CommandPalette — Escape before paint', () => {
  it('the Escape listener exists in the SAME commit that shows the dialog (before paint)', async () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prevAct = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let pressed = false;
    // A MutationObserver callback is a microtask: it runs after the commit that
    // inserted the dialog (and its layout effects), before the scheduler's next
    // task flushes passive effects. The fastest a person could press the key.
    const mo = new MutationObserver(() => {
      if (pressed || !host.querySelector('[role="dialog"]')) return;
      pressed = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    mo.observe(host, { childList: true, subtree: true });
    try {
      root.render(<MemoryRouter><CommandPalette openSignal={1} /></MemoryRouter>);
      await waitFor(() => expect(pressed).toBe(true));
      // Settle on a state both outcomes reach: the palette's passive effects have
      // run (focus is on its input), or the palette is already gone.
      await waitFor(() => expect(host.querySelector('[role="dialog"]') === null || document.activeElement?.getAttribute('role') === 'combobox').toBe(true));
      expect(host.querySelector('[role="dialog"]'), 'the early Escape was lost').toBeNull();
    } finally {
      mo.disconnect();
      root.unmount();
      host.remove();
      if (prevAct === undefined) delete g.IS_REACT_ACT_ENVIRONMENT; else g.IS_REACT_ACT_ENVIRONMENT = prevAct;
    }
  });

});
