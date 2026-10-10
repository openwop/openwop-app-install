/**
 * grade-ux CHATUX-1 (ADR 0764) — the composer's pickers are ARIA comboboxes:
 * focus stays in the textarea, so the highlighted option must be reachable by
 * `aria-activedescendant`. Before, options had no ids and nothing was reported —
 * a screen-reader user heard nothing when a picker opened or the highlight moved.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { AgentMentionAutocomplete } from '../AgentMentionAutocomplete.js';

// ChatInput mounts the audio recorder, which touches MediaRecorder (absent in jsdom).
vi.mock('../hooks/useAudioRecorder.js', () => ({
  useAudioRecorder: () => ({ isSupported: false, isRecording: false, error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
  blobToBase64: vi.fn(),
}));
// One owned workflow so the `/` picker has an option to highlight; no network.
vi.mock('../lib/workflowMentions.js', async (orig) => ({
  ...(await orig<typeof import('../lib/workflowMentions.js')>()),
  listWorkflowMentions: () => [{ workflowId: 'wf.daily', displayName: 'Daily report', slug: 'daily-report' }],
  refreshWorkflowMentionCache: async () => undefined,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ENTRIES = [
  { agentId: 'a1', slug: 'ada', displayName: 'Ada' },
  { agentId: 'a2', slug: 'alan', displayName: 'Alan' },
] as never;

describe('picker ↔ composer combobox wiring', () => {
  it('reports the highlighted option id, moves it with the arrows, and clears on close', () => {
    const onActiveChange = vi.fn();
    const combobox = { listboxId: 'lb', onActiveChange };
    const { container, rerender } = render(
      <AgentMentionAutocomplete text="@a" cursorPos={2} entriesOverride={ENTRIES} onPick={vi.fn()} onDismiss={vi.fn()} combobox={combobox} />,
    );
    expect(container.querySelector('[role="listbox"]')?.id).toBe('lb');
    expect(onActiveChange).toHaveBeenLastCalledWith('lb-opt-0');
    const first = container.querySelector('#lb-opt-0');
    expect(first?.getAttribute('aria-selected')).toBe('true');

    act(() => { fireEvent.keyDown(window, { key: 'ArrowDown' }); });
    expect(onActiveChange).toHaveBeenLastCalledWith('lb-opt-1');
    expect(container.querySelector('#lb-opt-1')?.getAttribute('aria-selected')).toBe('true');

    rerender(<AgentMentionAutocomplete text="hello" cursorPos={5} entriesOverride={ENTRIES} onPick={vi.fn()} onDismiss={vi.fn()} combobox={combobox} />);
    expect(onActiveChange).toHaveBeenLastCalledWith(null);
  });

  it('keyboard help text inside the listbox is hidden from AT (a listbox may only own options)', () => {
    const { container } = render(
      <AgentMentionAutocomplete text="@a" cursorPos={2} entriesOverride={ENTRIES} onPick={vi.fn()} onDismiss={vi.fn()} />,
    );
    const lb = container.querySelector('[role="listbox"]')!;
    for (const child of Array.from(lb.children)) {
      const isOption = child.getAttribute('role') === 'option';
      expect(isOption || child.getAttribute('aria-hidden') === 'true').toBe(true);
    }
  });
});

describe('ChatInput composer — the combobox role (ADR 0770, row-1 gap)', () => {
  it('is a combobox whose aria-controls resolves to a REAL element, closed and open', async () => {
    // The sibling pickers read their directories over HTTP; answer empty.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
    const { ChatInput } = await import('../ChatInput.js');
    const { getByRole, container } = render(<ChatInput onSend={vi.fn()} />);
    const ta = getByRole('combobox') as HTMLTextAreaElement;
    const controlled = (): Element | null => {
      const id = ta.getAttribute('aria-controls');
      return id ? container.ownerDocument.getElementById(id) : null;
    };
    // Closed: required by the role, and must not dangle.
    expect(ta.getAttribute('aria-expanded')).toBe('false');
    expect(controlled(), 'closed: aria-controls names an element in the DOM').not.toBeNull();
    expect(ta.hasAttribute('aria-activedescendant')).toBe(false);
    // Open the `/` picker: it now names the listbox, and the highlight is reachable.
    await act(async () => { fireEvent.change(ta, { target: { value: '/' } }); });
    expect(ta.getAttribute('aria-expanded')).toBe('true');
    expect(controlled()?.getAttribute('role'), 'open: aria-controls names the listbox').toBe('listbox');
    const active = ta.getAttribute('aria-activedescendant');
    expect(active && container.ownerDocument.getElementById(active)?.getAttribute('role')).toBe('option');
  });
});
