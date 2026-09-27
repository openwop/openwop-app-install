/**
 * ADR 0596 — the builder's AI drawer: the ADR 0137 seed hand-off (`WFAU-3`) and
 * the disclosure semantics of its trigger (`WFAU-5`).
 *
 * SCOPE, stated honestly: `BuilderShell` itself is not rendered by any test in
 * this repo (it pulls xyflow, the builder store and a dozen clients), and this
 * file does not change that. What it witnesses is the two pieces that were
 * EXTRACTED so they could be witnessed at all — the latch that `BuilderShell`
 * now calls, and the toolbar trigger it now passes `aiOpen` to. The remaining
 * half of `WFAU-5` (focus-in on open, focus restoration on close, Escape) lives
 * inside `BuilderShell`'s own JSX and is UNWITNESSED; it is recorded as an open
 * residual in ADR 0596 rather than papered over with a source-string grep, which
 * would police a spelling and not the behaviour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, renderHook, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useLatchedValue, drawerEscapeHandler } from '../builderShellHelpers.js';
import { BuilderToolbar } from '../BuilderToolbar.js';

afterEach(cleanup);

describe('WFAU-3 — the seed survives the router-state clear that destroys its source', () => {
  it('keeps the last defined value after the source goes undefined', () => {
    // This IS the bug, reduced: the prompt is a useMemo over `location.state`,
    // and the effect that opens the drawer clears that state in the same commit.
    const { result, rerender } = renderHook(({ v }) => useLatchedValue(v), {
      initialProps: { v: 'Create a workflow that does X.' as string | undefined },
    });
    expect(result.current).toBe('Create a workflow that does X.');
    rerender({ v: undefined }); // nav('.', { state: {} }) lands
    expect(result.current).toBe('Create a workflow that does X.');
  });

  it('is undefined until there has been something to latch (no phantom seed)', () => {
    const { result } = renderHook(() => useLatchedValue<string>(undefined));
    expect(result.current).toBeUndefined();
  });

  it('takes a later real value over the latched one (a second hand-off wins)', () => {
    const { result, rerender } = renderHook(({ v }) => useLatchedValue(v), {
      initialProps: { v: 'first' as string | undefined },
    });
    rerender({ v: undefined });
    rerender({ v: 'second' });
    expect(result.current).toBe('second');
    rerender({ v: undefined });
    expect(result.current).toBe('second');
  });
});

describe('WFAU-5 — the trigger is a DISCLOSURE, not a toggle button', () => {
  const toolbar = (aiOpen: boolean): void => {
    render(
      <MemoryRouter>
        <BuilderToolbar
          draft={null}
          onNewWorkflow={vi.fn()}
          onValidate={vi.fn()}
          onRun={vi.fn()}
          onCreateWithAi={vi.fn()}
          onSaveDraft={vi.fn()}
          name="wf"
          workflowId="wf-1"
          canUndo={false}
          canRedo={false}
          running={false}
          aiOpen={aiOpen}
          runEstimate={null}
          heatmapOn={false}
          onToggleHeatmap={vi.fn()}
          onOpenEvals={vi.fn()}
          /* The remaining props are supplied in full rather than cast away.
             `BuilderToolbarProps` is a closed interface, and the build's tsc
             EXCLUDES tests — only the `check-test-types` ratchet sees this
             file, so a partial fixture here is invisible to every gate the
             author is likely to run by hand. Completing it also keeps the
             toolbar rendering its real shape: a fixture missing the publish
             or collab arms renders a DIFFERENT toolbar than production, and
             an assertion about the AI trigger's siblings would then be
             passing against a component the user never sees. */
          undo={vi.fn()}
          redo={vi.fn()}
          onExport={vi.fn()}
          onOpenHistory={vi.fn()}
          onExportChainPack={vi.fn()}
          onPublishToRegistry={vi.fn()}
          onImportFile={vi.fn()}
          costHeatmapOn={false}
          onToggleCostHeatmap={vi.fn()}
          publish={null}
          onPublishChanges={vi.fn()}
          collab={null}
          onToggleCollab={vi.fn()}
        />
      </MemoryRouter>,
    );
  };

  it('exposes aria-expanded + aria-controls, and NOT aria-pressed', () => {
    toolbar(false);
    const btn = screen.getByRole('button', { expanded: false, name: /AI/i });
    expect(btn.getAttribute('aria-controls')).toBe('builder-ai-drawer');
    // `aria-pressed` described a two-state button and said nothing about the
    // region it governs; a disclosure that reports both is ambiguous to AT.
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
  });

  it('reports expanded when the drawer is open', () => {
    toolbar(true);
    const btn = screen.getByRole('button', { expanded: true, name: /AI/i });
    expect(btn.getAttribute('aria-controls')).toBe('builder-ai-drawer');
  });
});

/**
 * ADR 0596 §Correction 5 — the drawer's Escape handler must not steal Escape
 * from what the drawer CONTAINS.
 *
 * The regression this PR introduced: the AI drawer's `onKeyDown` sits on the
 * drawer element, making it a React-tree ancestor of the embedded chat. Two
 * in-chat handlers call `preventDefault()` WITHOUT `stopPropagation()` —
 * `chat/ChatInput` (Escape during a streaming turn = cancel the turn) and
 * `chat/MessageBubble` (Escape exits message-edit) — so pressing Escape to
 * cancel a turn ALSO slammed the drawer shut and yanked focus to the toolbar
 * trigger.
 *
 * SCOPE, stated honestly (as in this file's header): these render the real
 * shared `drawerEscapeHandler` over a REAL React tree, so the propagation
 * semantics under test (synthetic bubbling + `defaultPrevented` surviving the
 * hop) are the real ones. What they do NOT witness is the WIRING — that
 * `BuilderShell` passes this handler to the drawer div and renders the chat
 * inside it — because no test in this repo renders `BuilderShell`. That is the
 * standing `R3` limit, unchanged.
 */
describe('§Correction 5 — a descendant that already handled Escape keeps it', () => {
  const drawer = (): { close: ReturnType<typeof vi.fn> } => {
    const close = vi.fn();
    render(
      <div onKeyDown={drawerEscapeHandler(close)}>
        {/* the ChatInput / MessageBubble idiom: preventDefault, no stopPropagation */}
        <textarea
          data-testid="inner"
          onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); }}
        />
        <button data-testid="bare" type="button" />
      </div>,
    );
    return { close };
  };

  it('does NOT close when the chat already consumed Escape (preventDefault, no stopPropagation)', () => {
    const { close } = drawer();
    fireEvent.keyDown(screen.getByTestId('inner'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });

  it('DOES close when Escape reaches it unconsumed — the guard must not disable the drawer', () => {
    const { close } = drawer();
    fireEvent.keyDown(screen.getByTestId('bare'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores every other key', () => {
    const { close } = drawer();
    fireEvent.keyDown(screen.getByTestId('bare'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('bare'), { key: 'Tab' });
    expect(close).not.toHaveBeenCalled();
  });
});
