/**
 * ADR 0834 D3 — bypass is offered only to the conversation's owner. The server honours
 * it only for the principal the tools act as; for anyone else the switch would claim a
 * mode the server silently ignores. Born red: before ADR 0834 the switch was always shown
 * and always sent `bypass`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../ModelSwitcher.js', () => ({ ModelSwitcher: () => null }));
function NonOwnerControl({ onViewer }: { onViewer?: (v: { mayApprove: boolean; mayBypass: boolean }) => void }): null {
  useEffect(() => { onViewer?.({ mayApprove: false, mayBypass: false }); }, [onViewer]);
  return null;
}
vi.mock('../../conversationTools/ConversationToolsControl.js', () => ({ default: NonOwnerControl }));

import { useComposerModifiers } from '../hooks/useComposerModifiers.js';

function Harness(): JSX.Element {
  const { composerModifiers, getSubmitExtras } = useComposerModifiers({ sessionId: 's1', supportsWebSearch: false, supportsTools: false });
  return <div>{composerModifiers}<output data-testid="mode">{getSubmitExtras().permissionMode}</output></div>;
}

describe('permission mode is owner-only (ADR 0834 D3)', () => {
  it('a viewer without authority is not offered bypass, and the wire value stays safe', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'togglePermissionMode' })).toBeNull());
    expect(screen.getByTestId('mode').textContent).toBe('safe');
  });
});
