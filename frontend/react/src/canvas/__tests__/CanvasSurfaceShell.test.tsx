/**
 * CanvasSurfaceShell (ADR 0361 Phase 1) — the shell-chrome contract the live
 * parity pins verified at landing, pinned as regression tests: rail
 * collapse/expand with the consumer's announcements, `[`/`]` registry
 * shortcuts, type-verb dispatch through the window-keydown owner, the `?`
 * cheatsheet, and ⌘K command-source registration under the STABLE storageKey.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CanvasSurfaceShell, type SurfaceShellConfig } from '../CanvasSurfaceShell.js';
import { getContributedCommands, __resetCommandSources } from '../../ui/commandContributions.js';

const rail = (side: string, w: number) => ({
  content: <div data-testid={`rail-${side}`} />,
  className: `test-rail-${side}`,
  label: `${side} rail`,
  expandLabel: `Expand ${side}`,
  collapseLabel: `Collapse ${side}`,
  resizeLabel: `Resize ${side}`,
  announceCollapsed: `${side} collapsed`,
  announceExpanded: `${side} expanded`,
  defaultW: w,
});

let verbRuns = 0;
const config: SurfaceShellConfig = {
  storageKey: 'test-surface-shell',
  shellClassName: 'test-shell',
  colsClassName: 'test-cols',
  bar: () => <div data-testid="bar" />,
  railL: rail('left', 200),
  railR: rail('right', 300),
  center: <div data-testid="center" />,
  tail: <div data-testid="tail" />,
  typeShortcuts: ({ announce }) => [
    { combo: 'mod+d', labelKey: 'verbLabel', group: 'type', run: () => { verbRuns += 1; announce('verb ran'); } },
  ],
  typeT: (k) => `T:${k}`,
  commandsGroupLabel: 'Test commands',
};

beforeEach(() => { verbRuns = 0; localStorage.clear(); __resetCommandSources(); });
afterEach(cleanup);

describe('CanvasSurfaceShell (ADR 0361)', () => {
  it('renders bar, rails, center, and tail slots', () => {
    const { container } = render(<CanvasSurfaceShell config={config} />);
    for (const id of ['bar', 'rail-left', 'rail-right', 'center', 'tail']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(container.querySelector('[data-canvas-layout="workbench"]')).toBeTruthy();
    const status = screen.getByLabelText('Canvas status');
    expect(status.textContent).toContain('Keyboard shortcuts');
    // Type drawers/tails remain above the stable workbench status edge.
    expect(screen.getByTestId('tail').compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses/expands a rail via its chevron and announces the consumer strings', () => {
    render(<CanvasSurfaceShell config={config} />);
    const aside = screen.getByLabelText('left rail');
    expect(aside.className).not.toContain('is-collapsed');
    fireEvent.click(screen.getByLabelText('Collapse left'));
    expect(aside.className).toContain('is-collapsed');
    expect(screen.getByRole('status').textContent).toBe('left collapsed');
    fireEvent.click(screen.getByLabelText('Expand left'));
    expect(aside.className).not.toContain('is-collapsed');
    expect(screen.getByRole('status').textContent).toBe('left expanded');
  });

  it('[ and ] toggle the rails through the window-keydown owner', () => {
    render(<CanvasSurfaceShell config={config} />);
    fireEvent.keyDown(window, { key: '[' });
    expect(screen.getByLabelText('left rail').className).toContain('is-collapsed');
    fireEvent.keyDown(window, { key: ']' });
    expect(screen.getByLabelText('right rail').className).toContain('is-collapsed');
  });

  it('dispatches the consumer type verb and skips it inside text contexts', () => {
    render(<CanvasSurfaceShell config={config} />);
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(verbRuns).toBe(1);
    expect(screen.getByRole('status').textContent).toBe('verb ran');
    // A keydown originating in a text field never triggers verbs (inTextContext).
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'd', metaKey: true });
    expect(verbRuns).toBe(1);
    input.remove();
  });

  it('? opens the shortcuts cheatsheet listing the type verb via typeT', () => {
    render(<CanvasSurfaceShell config={config} />);
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain('T:verbLabel');
  });

  it('registers the ⌘K command source under the storageKey and unregisters on unmount', () => {
    const { unmount } = render(<CanvasSurfaceShell config={config} />);
    const cmds = getContributedCommands();
    expect(cmds.some((c) => c.id === 'test-surface-shell-mod+d' && c.label === 'T:verbLabel')).toBe(true);
    unmount();
    expect(getContributedCommands().some((c) => c.id.startsWith('test-surface-shell-'))).toBe(false);
  });
});
