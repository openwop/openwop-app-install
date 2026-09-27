/**
 * UX_UPGRADE-workflows-builder P1 — a failed read must not render as absence.
 *
 * UX-BLD-1: `loadDebugSessionFromServer` was called with a bare
 * `.catch(() => {})`, so a 5xx/offline pin read left `debugSession` null and
 * `DebugSessionBanner` unrendered — telling the author "no pins" while the
 * server still held them. That is the exact dishonesty ADR 0475's banner is
 * built to prevent ("the author must always be able to SEE that pins exist").
 * The 404 arm stays silent on purpose: an unsaved local-only draft has no
 * server workflow to ask.
 *
 * UX-BLD-2: the run-cost chip is fail-soft by design (ADR 0476), but BOTH
 * "no estimate yet" and "the estimate read failed" collapsed into an absent
 * chip, so someone about to fire an expensive AI workflow got identical
 * silence either way. Fail-soft means the chip is optional, not that a failure
 * may masquerade as free.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { isMissingResourceError } from '../builderShellHelpers.js';
import { BuilderToolbar } from '../BuilderToolbar.js';

afterEach(cleanup);

describe('UX-BLD-1 — the missing-vs-failed split', () => {
  it('treats a _404 as "nothing to ask" (stays silent)', () => {
    expect(isMissingResourceError(new Error('workflow_404'))).toBe(true);
    expect(isMissingResourceError(new Error('debug_pins_404'))).toBe(true);
  });

  it('treats every OTHER failure as worth reporting', () => {
    // These are the ones that used to vanish into `.catch(() => {})`.
    for (const m of ['workflow_500', 'pins_503', 'network_error', 'unauthorized_401', '']) {
      expect(isMissingResourceError(new Error(m)), `${m} must not be read as missing`).toBe(false);
    }
  });

  it('does not mistake a 404 appearing mid-message for the suffix', () => {
    // The rule is suffix-anchored; a 404 in the middle is a different error.
    expect(isMissingResourceError(new Error('http_404_gateway_timeout'))).toBe(false);
  });

  it('is safe on non-Error rejections', () => {
    expect(isMissingResourceError('workflow_404')).toBe(false);
    expect(isMissingResourceError(undefined)).toBe(false);
    expect(isMissingResourceError(null)).toBe(false);
  });
});

describe('UX-BLD-2 — an unavailable cost estimate never reads as a price', () => {
  const toolbar = (runEstimate: { label: string; title: string; unavailable?: boolean } | null): void => {
    render(
      <MemoryRouter>
        <BuilderToolbar
          draft={null}
          onSaveDraft={vi.fn()}
          name="Test workflow"
          workflowId="wf:test"
          canUndo={false}
          canRedo={false}
          running={false}
          aiOpen={false}
          undo={vi.fn()}
          redo={vi.fn()}
          onExport={vi.fn()}
          onOpenHistory={vi.fn()}
          onExportChainPack={vi.fn()}
          onPublishToRegistry={vi.fn()}
          onImportFile={vi.fn()}
          onNewWorkflow={vi.fn()}
          onValidate={vi.fn()}
          onRun={vi.fn()}
          onCreateWithAi={vi.fn()}
          runEstimate={runEstimate}
          heatmapOn={false}
          onToggleHeatmap={vi.fn()}
          onOpenEvals={vi.fn()}
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

  it('renders no chip when there is genuinely no estimate', () => {
    toolbar(null);
    expect(document.querySelector('.chip--muted')).toBeNull();
    expect(document.querySelector('.chip--warning')).toBeNull();
  });

  it('renders the cost as a MUTED chip when the estimate loaded', () => {
    toolbar({ label: '~$0.02/run', title: 'from 12 runs' });
    expect(screen.getByText('~$0.02/run')).toBeTruthy();
    expect(document.querySelector('.chip--muted')).toBeTruthy();
    // A real price must never borrow the warning register.
    expect(document.querySelector('.chip--warning')).toBeNull();
  });

  it('renders a WARNING chip — not silence — when the read failed', () => {
    toolbar({ label: 'Cost estimate unavailable', title: 'could not be loaded', unavailable: true });
    expect(screen.getByText('Cost estimate unavailable')).toBeTruthy();
    // The defect was that this state was indistinguishable from "no estimate".
    expect(document.querySelector('.chip--warning')).toBeTruthy();
    expect(document.querySelector('.chip--muted')).toBeNull();
  });
});
