/**
 * UI-1 (CODEBASE-ASSESSMENT.md): the AppGate (a security-relevant surface) was
 * untested. Covers the password-gate accept/reject path + persistence and the
 * "no password configured" disabled state. The mode/password come from `brand`,
 * mocked here so the test is deployment-independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const brandMock = vi.hoisted(() => ({
  productName: 'TestProduct',
  instanceName: 'TestInstance',
  appGate: { mode: 'password' as 'password' | 'sign-in' | 'none', password: 'sekret' },
}));
vi.mock('../../brand/brand.js', () => ({ brand: brandMock }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false, isConfigured: false }) }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => null }));

import { AppGate } from '../AppGate.js';

beforeEach(() => {
  localStorage.clear();
  brandMock.appGate.mode = 'password';
  brandMock.appGate.password = 'sekret';
});
afterEach(cleanup);

describe('AppGate password mode', () => {
  it('hides children until the correct password is entered, then persists', () => {
    render(<AppGate><div>SECRET CONTENT</div></AppGate>);
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();
    expect(screen.getByText(/did not match/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'sekret' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('SECRET CONTENT')).toBeTruthy();

    // Unlock persisted to localStorage → a freshly-mounted gate is open.
    cleanup();
    render(<AppGate><div>FRESH CONTENT</div></AppGate>);
    expect(screen.getByText('FRESH CONTENT')).toBeTruthy();
  });

  it('shows a disabled gate when configured for password mode but none supplied', () => {
    brandMock.appGate.password = '';
    render(<AppGate><div>SECRET CONTENT</div></AppGate>);
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();
    expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(true);
  });

  it('mode "none" renders children directly', () => {
    brandMock.appGate.mode = 'none';
    render(<AppGate><div>OPEN CONTENT</div></AppGate>);
    expect(screen.getByText('OPEN CONTENT')).toBeTruthy();
  });
});
