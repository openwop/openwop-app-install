/**
 * ADR 0768 P5 + P6 — the Pocket (launcher + non-modal popover over the ONE
 * embedded chat), mobile pane arbitration, and the compact composer.
 */
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { name?: string }) => (o?.name ? `${k}:${o.name}` : k) }),
}));
const panelProps: Array<Record<string, unknown>> = [];
vi.mock('../EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: (p: Record<string, unknown>) => { panelProps.push(p); return <textarea aria-label="composer" />; },
}));
vi.mock('../AgentMentionAutocomplete.js', () => ({ AgentMentionAutocomplete: () => null }));
vi.mock('../SlashAutocomplete.js', () => ({ SlashAutocomplete: () => null }));
vi.mock('../BoardMentionAutocomplete.js', () => ({ BoardMentionAutocomplete: () => null }));
vi.mock('../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
}));

import { ChatPocket } from '../ChatPocket.js';
import { useMobilePaneArbitration } from '../workbench/useWorkbench.js';
import { ChatInput } from '../ChatInput.js';

describe('ChatPocket', () => {
  it('opens the ONE embedded chat at pocket density, with the feature-stated scope', () => {
    panelProps.length = 0;
    render(<ChatPocket agentId="store" title="Store Assistant" contextLabel="your stores" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /pocketAsk:Store Assistant/ }));
    expect(screen.getByRole('dialog', { name: 'Store Assistant' })).toBeTruthy();
    expect(panelProps.at(-1)).toMatchObject({ agentId: 'store', density: 'pocket', contextLabel: 'your stores' });
  });

  it('moves focus in on open and back to the launcher on Esc', () => {
    render(<ChatPocket agentId="a" title="Helper" />);
    const launcher = screen.getByRole('button', { name: /pocketAsk:Helper/ });
    fireEvent.click(launcher);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('composer');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it('keeps the conversation mounted while closed (closing never discards the thread)', () => {
    panelProps.length = 0;
    render(<ChatPocket agentId="a" title="Helper" defaultOpen />);
    // The pocket now lives in the existing body portal, outside render.container.
    // Capture the actual nodes so the original hidden-but-mounted intent remains.
    const pocket = screen.getByRole('dialog', { name: 'Helper' });
    const composer = screen.getByRole('textbox', { name: 'composer' });
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error('composer is not a textarea');
    fireEvent.change(composer, { target: { value: 'retained unsent draft' } });
    fireEvent.click(screen.getByRole('button', { name: /pocketClose:Helper/ }));
    expect(pocket.hasAttribute('hidden')).toBe(true);
    expect(pocket.querySelector('textarea')).not.toBeNull();
    expect(pocket.querySelector('textarea')).toBe(composer);
    expect(composer.isConnected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /pocketAsk:Helper/ }));
    expect(screen.getByRole('dialog', { name: 'Helper' })).toBe(pocket);
    expect(screen.getByRole('textbox', { name: 'composer' })).toBe(composer);
    expect(composer.value).toBe('retained unsent draft');
  });

  it('places both launcher and dialog outside the feature section that owns page-arrival motion', () => {
    render(<main className="page-enter"><section aria-label="Feature content">
      <ChatPocket agentId="store" title="Store Assistant" contextLabel="current client" />
    </section></main>);
    const feature = screen.getByRole('region', { name: 'Feature content' });
    const launcher = screen.getByRole('button', { name: /pocketAsk:Store Assistant/ });
    expect(feature.contains(launcher)).toBe(false);
    expect(launcher.parentElement).toBe(document.body);
    fireEvent.click(launcher);
    const pocket = screen.getByRole('dialog', { name: 'Store Assistant' });
    expect(feature.contains(pocket)).toBe(false);
    expect(pocket.parentElement).toBe(document.body);
    expect(pocket.getAttribute('aria-modal')).toBe('false');
    expect(panelProps.at(-1)).toMatchObject({ agentId: 'store', density: 'pocket', contextLabel: 'current client' });
    // Structural portal proof only: jsdom cannot establish physical geometry.
  });

  it('default-open portal close restores the real launcher focus and unmount removes its chrome', () => {
    const { unmount } = render(<section aria-label="Feature content"><ChatPocket agentId="a" title="Helper" defaultOpen /></section>);
    const pocket = screen.getByRole('dialog', { name: 'Helper' });
    const composer = screen.getByRole('textbox', { name: 'composer' });
    expect(document.activeElement).toBe(composer);
    fireEvent.click(screen.getByRole('button', { name: /pocketClose:Helper/ }));
    const launcher = screen.getByRole('button', { name: /pocketAsk:Helper/ });
    expect(document.activeElement).toBe(launcher);
    expect(pocket.hasAttribute('hidden')).toBe(true);
    unmount();
    expect(pocket.isConnected).toBe(false);
    expect(launcher.isConnected).toBe(false);
  });

  it('toggles with Mod+J', () => {
    render(<ChatPocket agentId="a" title="Helper" />);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true })); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true })); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('useMobilePaneArbitration', () => {
  const setup = (isMobile: boolean) => {
    const closeRail = vi.fn();
    const closeWorkbench = vi.fn();
    const hook = renderHook(
      ({ rail, wb }: { rail: boolean; wb: boolean }) => useMobilePaneArbitration(isMobile, rail, wb, closeRail, closeWorkbench),
      { initialProps: { rail: false, wb: false } },
    );
    return { ...hook, closeRail, closeWorkbench };
  };

  it('opening the workbench over an open rail closes the rail', () => {
    const h = setup(true);
    h.rerender({ rail: true, wb: false });
    h.rerender({ rail: true, wb: true });
    expect(h.closeRail).toHaveBeenCalledOnce();
    expect(h.closeWorkbench).not.toHaveBeenCalled();
  });

  it('opening the rail over an open workbench closes the workbench', () => {
    const h = setup(true);
    h.rerender({ rail: false, wb: true });
    h.rerender({ rail: true, wb: true });
    expect(h.closeWorkbench).toHaveBeenCalledOnce();
    expect(h.closeRail).not.toHaveBeenCalled();
  });

  it('does nothing above the mobile breakpoint', () => {
    const h = setup(false);
    h.rerender({ rail: true, wb: true });
    expect(h.closeRail).not.toHaveBeenCalled();
    expect(h.closeWorkbench).not.toHaveBeenCalled();
  });
});

describe('compact composer', () => {
  it('folds the sigil chips into the + menu', () => {
    render(<ChatInput onSend={vi.fn()} compact boardSigil />);
    expect(screen.queryByRole('button', { name: 'sigilWorkflowAria' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'composerMoreActions' }));
    for (const name of ['attachFile', 'sigilWorkflowAria', 'sigilAgentAria', 'sigilBoardAria']) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy();
    }
  });

  it('keeps the visible chips on a wide composer', () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'sigilWorkflowAria' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'composerMoreActions' })).toBeNull();
  });
});
