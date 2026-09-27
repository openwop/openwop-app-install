/**
 * ADR 0724 / PMU-1 — bypass is a SECURITY switch. Its active state carries a warning
 * affordance (class + AlertIcon) and the consequence is rendered INLINE, not only in the
 * hover tooltip; safe (the default) shows neither. Born red: before the fix the active
 * button carried the same `composer-modifier` class as every other toggle and no hint.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../ModelSwitcher.js', () => ({ ModelSwitcher: () => null }));
vi.mock('../../conversationTools/CapabilityScopePanel.js', () => ({ CapabilityScopeButton: () => null }));

import { useComposerModifiers } from '../hooks/useComposerModifiers.js';

function Harness(): JSX.Element {
  const { composerModifiers, getSubmitExtras } = useComposerModifiers({ sessionId: 's1', supportsWebSearch: false, supportsTools: false });
  return <div>{composerModifiers}<output data-testid="mode">{getSubmitExtras().permissionMode}</output></div>;
}

const modeBtn = () => screen.getByRole('button', { name: 'togglePermissionMode' });

describe('permission mode affordance (ADR 0724 / PMU-1)', () => {
  it('default is safe: no warning class, no inline hint, and the wire value is `safe`', () => {
    render(<Harness />);
    expect(modeBtn().getAttribute('aria-pressed')).toBe('false');
    expect(modeBtn().className).toBe('composer-modifier');
    expect(screen.queryByTestId('permission-bypass-hint')).toBeNull();
    expect(screen.getByTestId('mode').textContent).toBe('safe');
  });

  it('enabling bypass adds the warning affordance AND the inline consequence; the wire value flips', () => {
    render(<Harness />);
    fireEvent.click(modeBtn());
    expect(modeBtn().getAttribute('aria-pressed')).toBe('true');
    expect(modeBtn().className).toContain('is-bypass');
    const hint = screen.getByTestId('permission-bypass-hint');
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.textContent).toBe('permissionBypassHint');
    expect(screen.getByTestId('mode').textContent).toBe('bypass');
  });

  it('disabling bypass removes both again', () => {
    render(<Harness />);
    fireEvent.click(modeBtn()); fireEvent.click(modeBtn());
    expect(modeBtn().className).toBe('composer-modifier');
    expect(screen.queryByTestId('permission-bypass-hint')).toBeNull();
    expect(screen.getByTestId('mode').textContent).toBe('safe');
  });
});
