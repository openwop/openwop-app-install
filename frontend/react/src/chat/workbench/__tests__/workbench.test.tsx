/**
 * ADR 0768 P2 — the chat Workbench: its state hook (persistence, the artifact
 * fallback) and the pane (tabs, one close, the Run panel without its own header).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../artifacts/ArtifactWorkbench.js', () => ({
  ArtifactWorkbench: ({ artifactId, docked }: { artifactId: string; docked?: boolean }) => (
    <div data-testid="artifact" data-docked={String(Boolean(docked))}>{artifactId}</div>
  ),
}));

import { useWorkbench, workbenchKey } from '../useWorkbench.js';
import { Workbench } from '../Workbench.js';

beforeEach(() => localStorage.clear());

describe('useWorkbench', () => {
  it('persists the Run tab per tenant and restores it', () => {
    const { result } = renderHook(() => useWorkbench('t1'));
    act(() => result.current.openRun());
    expect(localStorage.getItem(workbenchKey('t1'))).toBe('run');
    const again = renderHook(() => useWorkbench('t1'));
    expect(again.result.current.tab).toBe('run');
  });

  it('never restores an artifact tab (the id is session-local)', () => {
    const { result } = renderHook(() => useWorkbench('t1'));
    act(() => result.current.openArtifact({ artifactId: 'a1' }));
    expect(result.current.tab).toBe('artifact');
    expect(localStorage.getItem(workbenchKey('t1'))).toBeNull();
  });

  it('closing an artifact falls back to Run only when there are runs', () => {
    const { result } = renderHook(() => useWorkbench('t1'));
    act(() => result.current.openArtifact({ artifactId: 'a1' }));
    act(() => result.current.closeArtifact(true));
    expect(result.current).toMatchObject({ tab: 'run', artifact: null });
    act(() => result.current.openArtifact({ artifactId: 'a2' }));
    act(() => result.current.closeArtifact(false));
    expect(result.current.tab).toBeNull();
  });

  it('does not persist when tenantId is null (the multi-tab deck)', () => {
    const { result } = renderHook(() => useWorkbench(null));
    act(() => result.current.openRun());
    expect(localStorage.length).toBe(0);
  });

  it('honours an initial tab (the legacy `progress` rail migration)', () => {
    const { result } = renderHook(() => useWorkbench('t2', 'run'));
    expect(result.current.tab).toBe('run');
  });
});

const runProps = { workflowRunMessages: [], focusedMessageId: null, onFocus: vi.fn(), onCancel: vi.fn(async () => undefined) };

describe('Workbench pane', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Workbench tab={null} onSelectTab={vi.fn()} onClose={vi.fn()} isMobile={false} runProps={runProps} artifact={null} onCloseArtifact={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows Run with ONE close (the progress panel header is suppressed)', () => {
    const onClose = vi.fn();
    render(<Workbench tab="run" onSelectTab={vi.fn()} onClose={onClose} isMobile={false} runProps={runProps} artifact={null} onCloseArtifact={vi.fn()} />);
    expect(screen.getByRole('complementary', { name: 'workbenchAria' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /workbenchTabArtifact/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'closeWorkflowProgress' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'workbenchClose' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('docks the artifact viewer on the Artifact tab', async () => {
    render(<Workbench tab="artifact" onSelectTab={vi.fn()} onClose={vi.fn()} isMobile={false} runProps={runProps} artifact={{ artifactId: 'art-9' }} onCloseArtifact={vi.fn()} />);
    const el = await screen.findByTestId('artifact');
    expect(el.textContent).toBe('art-9');
    expect(el.getAttribute('data-docked')).toBe('true');
  });

  it('switches tabs with the arrow keys', () => {
    const onSelectTab = vi.fn();
    render(<Workbench tab="run" onSelectTab={onSelectTab} onClose={vi.fn()} isMobile={false} runProps={runProps} artifact={{ artifactId: 'a' }} onCloseArtifact={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onSelectTab).toHaveBeenCalledWith('artifact');
  });
});
