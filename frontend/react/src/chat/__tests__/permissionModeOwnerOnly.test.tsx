/**
 * ADR 0834 D3 — bypass is offered only to the conversation's owner. The server honours
 * it only for the principal the tools act as; for anyone else the switch would claim a
 * mode the server silently ignores. Born red: before ADR 0834 the switch was always shown
 * and always sent `bypass`.
 *
 * The scope control is stubbed to CAPTURE its `onViewer` callback, so the test decides when
 * authority resolves. Case 2 covers the optimistic window (`mayBypass` starts true until the
 * scope read answers): a viewer who turned bypass on before the answer must fall back to
 * `safe` on the wire. grade-tests w28: the wire-value claim used to be unfailable (the button
 * was never pressed); dropping the `&& mayBypass` term now reds case 2.
 */
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Viewer = { mayApprove: boolean; mayBypass: boolean };
const viewer = vi.hoisted(() => {
  /** autoNonOwner: true ⇒ the stub reports a non-owner as soon as it mounts (the scope read answering). */
  const state: { cb: ((v: Viewer) => void) | undefined; autoNonOwner: boolean } = { cb: undefined, autoNonOwner: true };
  return state;
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../ModelSwitcher.js', () => ({ ModelSwitcher: () => null }));
function CapturingControl({ onViewer }: { onViewer?: (v: Viewer) => void }): null {
  viewer.cb = onViewer;
  // Answer AFTER an await, like the real control (`await getCapabilityScope` → onViewer). A
  // synchronous answer in a child effect is overwritten by the hook's own per-session reset
  // effect (parent effects run after children) once the lazy module is cached — an artefact
  // of the stub that made the case order-dependent under shuffle (grade-tests w28).
  useEffect(() => {
    if (viewer.autoNonOwner) void Promise.resolve().then(() => onViewer?.({ mayApprove: false, mayBypass: false }));
  }, [onViewer]);
  return null;
}
vi.mock('../../conversationTools/ConversationToolsControl.js', () => ({ default: CapturingControl }));

import { useComposerModifiers } from '../hooks/useComposerModifiers.js';

function Harness(): JSX.Element {
  const { composerModifiers, getSubmitExtras } = useComposerModifiers({ sessionId: 's1', supportsWebSearch: false, supportsTools: false });
  return <div>{composerModifiers}<output data-testid="mode">{getSubmitExtras().permissionMode}</output></div>;
}

const modeBtn = () => screen.queryByRole('button', { name: 'togglePermissionMode' });

describe('permission mode is owner-only (ADR 0834 D3)', () => {
  beforeEach(() => { viewer.cb = undefined; viewer.autoNonOwner = true; });

  it('a viewer without authority is not offered bypass, and the wire value stays safe', async () => {
    render(<Harness />);
    await waitFor(() => expect(viewer.cb).toBeDefined());
    await waitFor(() => expect(modeBtn()).toBeNull());
    expect(screen.getByTestId('mode').textContent).toBe('safe');
  });

  it('a viewer who enabled bypass before authority resolved falls back to safe on the wire', async () => {
    viewer.autoNonOwner = false;
    render(<Harness />);
    await waitFor(() => expect(viewer.cb).toBeDefined());
    // Optimistic window: the switch is offered and pressing it really sends bypass (positive control).
    const btn = modeBtn();
    expect(btn).not.toBeNull();
    if (btn) fireEvent.click(btn);
    expect(screen.getByTestId('mode').textContent).toBe('bypass');
    // The scope read answers: not the owner.
    act(() => { viewer.cb?.({ mayApprove: false, mayBypass: false }); });
    expect(modeBtn()).toBeNull();
    expect(screen.getByTestId('mode').textContent).toBe('safe');
  });
});
