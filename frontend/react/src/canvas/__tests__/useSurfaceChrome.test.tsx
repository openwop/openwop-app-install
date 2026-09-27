/**
 * useSurfaceChrome (ADR 0365) — direct pins for the shared chrome-behavior
 * blocks. The shell/page suites exercise these transitively; this file pins
 * the contracts that moved OUT of the compositions with no direct coverage
 * (the grade-pass finding): the dual-channel announcer routing (RFC 0130 —
 * assertive plugin announces vs the polite default), the dispatcher's
 * IDENTITY STABILITY across renders (the GC-CV-3 PluginFrame re-subscribe
 * fix), the registry commit→keydown-dispatch timing, and the ⌘K projection
 * (frozen id prefix, label-ns routing, enabled filter, unregister lifecycle).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEffect, useRef } from 'react';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useSurfaceChrome, type SurfaceChrome, type SurfaceChromeOptions } from '../useSurfaceChrome.js';
import type { ShortcutDef } from '../shortcuts.js';
import { getContributedCommands, __resetCommandSources } from '../../ui/commandContributions.js';

const OPTS: SurfaceChromeOptions = {
  commandSourceKey: 'test-chrome',
  commandIdPrefix: 'tc',
  commandsGroupLabel: 'Test group',
  typeT: (k) => `T:${k}`,
  canvasT: (k) => `C:${k}`,
};

function Harness({ shortcuts, onChrome }: {
  shortcuts: ShortcutDef[];
  onChrome: (chrome: SurfaceChrome, renderCount: number) => void;
}): JSX.Element {
  const chrome = useSurfaceChrome(OPTS);
  chrome.commitShortcuts(shortcuts);
  const renders = useRef(0);
  renders.current += 1;
  onChrome(chrome, renders.current);
  useEffect(() => { /* commit */ });
  return (
    <div>
      <span data-testid="polite">{chrome.announce}</span>
      <span data-testid="assertive">{chrome.announceAssertive}</span>
    </div>
  );
}

beforeEach(() => { cleanup(); __resetCommandSources(); });

describe('useSurfaceChrome (ADR 0365)', () => {
  it('routes dispatchAnnounce by politeness — assertive never clobbers the polite channel', () => {
    let chrome!: SurfaceChrome;
    const { getByTestId } = render(<Harness shortcuts={[]} onChrome={(c) => { chrome = c; }} />);
    act(() => {
      chrome.dispatchAnnounce('moved');
      chrome.dispatchAnnounce('plugin says', 'assertive');
    });
    expect(getByTestId('polite').textContent).toBe('moved');
    expect(getByTestId('assertive').textContent).toBe('plugin says');
  });

  it('re-announces a REPEATED message — a live region only speaks on mutation', () => {
    // Setting the same string is a no-op end to end (React bails on
    // Object.is-equal state; the reconciler skips an equal text update), so the
    // second identical announce would be SILENT. That is wrong for anything a
    // user can legitimately trigger twice — two dead-end Alt+Arrow presses in
    // different directions, or ⌘A twice. `withRepeatMark` flips an invisible
    // zero-width space so each repeat is a distinct value; the SPOKEN text is
    // unchanged, which is why the visible-text assertion trims it.
    let chrome!: SurfaceChrome;
    const { getByTestId } = render(<Harness shortcuts={[]} onChrome={(c) => { chrome = c; }} />);
    act(() => { chrome.dispatchAnnounce('No downstream node.'); });
    const first = getByTestId('polite').textContent!;
    act(() => { chrome.dispatchAnnounce('No downstream node.'); });
    const second = getByTestId('polite').textContent!;

    expect(second).not.toBe(first);                                  // the region MUTATED
    expect(second.replace(/​/g, '')).toBe('No downstream node.'); // …but reads the same
    // And a third repeat flips back, so it never grows without bound.
    act(() => { chrome.dispatchAnnounce('No downstream node.'); });
    const third = getByTestId('polite').textContent!;
    expect(third).not.toBe(second);
    expect(third).toBe(first);
  });

  it('dispatchAnnounce is IDENTITY-STABLE across renders (the GC-CV-3 re-subscribe fix)', () => {
    const seen: SurfaceChrome['dispatchAnnounce'][] = [];
    const { rerender } = render(<Harness shortcuts={[]} onChrome={(c) => { seen.push(c.dispatchAnnounce); }} />);
    rerender(<Harness shortcuts={[]} onChrome={(c) => { seen.push(c.dispatchAnnounce); }} />);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });

  it('committed shortcuts dispatch through the window-keydown owner post-commit', () => {
    let ran = 0;
    const defs: ShortcutDef[] = [
      { combo: 'mod+m', labelKey: 'verb', group: 'type', run: () => { ran += 1; } },
    ];
    render(<Harness shortcuts={defs} onChrome={() => undefined} />);
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    expect(ran).toBe(1);
    // Text contexts never dispatch (inTextContext guard).
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'm', metaKey: true });
    expect(ran).toBe(1);
    input.remove();
  });

  it('projects the registry into ⌘K: frozen id prefix, per-group label ns, enabled filter', () => {
    const defs: ShortcutDef[] = [
      { combo: 'mod+m', labelKey: 'verb', group: 'type', run: () => undefined },
      { combo: 'mod+g', labelKey: 'general', group: 'general', run: () => undefined },
      { combo: 'mod+x', labelKey: 'off', group: 'type', enabled: () => false, run: () => undefined },
    ];
    render(<Harness shortcuts={defs} onChrome={() => undefined} />);
    const cmds = getContributedCommands().filter((c) => c.id.startsWith('tc-'));
    expect(cmds.map((c) => c.id).sort()).toEqual(['tc-mod+g', 'tc-mod+m']); // enabled filter dropped mod+x
    expect(cmds.find((c) => c.id === 'tc-mod+m')!.label).toBe('T:verb');     // type ns
    expect(cmds.find((c) => c.id === 'tc-mod+g')!.label).toBe('C:general');  // canvas ns
    expect(cmds.every((c) => c.group === 'Test group')).toBe(true);
  });

  it('unregisters the ⌘K source on unmount', () => {
    const { unmount } = render(<Harness shortcuts={[{ combo: 'mod+m', labelKey: 'verb', group: 'type', run: () => undefined }]} onChrome={() => undefined} />);
    expect(getContributedCommands().some((c) => c.id.startsWith('tc-'))).toBe(true);
    unmount();
    expect(getContributedCommands().some((c) => c.id.startsWith('tc-'))).toBe(false);
  });
});
