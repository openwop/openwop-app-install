/**
 * UI-1 (docs/steward/CODEBASE-ASSESSMENT.md): the AppGate (a security-relevant surface) was
 * untested. Covers the password-gate accept/reject path + persistence, the "no password
 * configured" disabled state, mode "none", and (GT-APPGATE-SIGNIN-1, /grade-tests w35) the
 * sign-in mode: a protected child must NOT render while auth is still resolving or signed out.
 * The mode/password come from `brand` and the session from `useAuth`, both mocked here so the
 * test is deployment-independent.
 *
 * Sabotage that turns it red: accept any non-empty password; drop `persistUnlocked`; never
 * disable the empty-password gate; gate mode "none"; render the mismatch error without
 * `role="alert"` (a conditionally mounted `status` is silent); let `SignInGate` render its
 * children while `loading`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { UseAuth } from '../../auth/useAuth.js';

const brandMock = vi.hoisted(() => ({
  productName: 'TestProduct',
  instanceName: 'TestInstance',
  appGate: { mode: 'password' as 'password' | 'sign-in' | 'none', password: 'sekret' },
}));
const authMock = vi.hoisted(() => ({
  state: { user: null, loading: false, isConfigured: false } as Pick<UseAuth, 'user' | 'loading' | 'isConfigured'>,
}));
vi.mock('../../brand/brand.js', () => ({ brand: brandMock }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => authMock.state }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => null }));

import { AppGate } from '../AppGate.js';

beforeEach(() => {
  localStorage.clear();
  brandMock.appGate.mode = 'password';
  brandMock.appGate.password = 'sekret';
  authMock.state = { user: null, loading: false, isConfigured: false };
});
afterEach(cleanup);

describe('AppGate password mode', () => {
  it('hides children until the correct password is entered, then persists', () => {
    render(<AppGate><div>SECRET CONTENT</div></AppGate>);
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();
    // An `alert` is announced on insertion; a conditionally mounted `status` is not.
    expect(screen.getByRole('alert').textContent).toMatch(/did not match/i);

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

describe('AppGate sign-in mode (GT-APPGATE-SIGNIN-1)', () => {
  const user = { uid: 'u1', email: 'u1@example.test', displayName: 'U One', photoURL: null, providerIds: ['google.com'] };

  it('while the session is still resolving, the child does NOT render (the gate decides first)', () => {
    brandMock.appGate.mode = 'sign-in';
    authMock.state = { user: null, loading: true, isConfigured: true };
    render(<AppGate><div>SECRET CONTENT</div></AppGate>);
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();
    expect(screen.getByText('Checking your session.')).toBeTruthy();
  });

  it('signed out (resolved): the sign-in wall, never the child', () => {
    brandMock.appGate.mode = 'sign-in';
    authMock.state = { user: null, loading: false, isConfigured: true };
    render(<AppGate><div>SECRET CONTENT</div></AppGate>);
    expect(screen.queryByText('SECRET CONTENT')).toBeNull();
    expect(screen.getByText('Sign in to open this workspace.')).toBeTruthy();
  });

  it('signed in: the child renders', () => {
    brandMock.appGate.mode = 'sign-in';
    authMock.state = { user, loading: false, isConfigured: true };
    render(<AppGate><div>SECRET CONTENT</div></AppGate>);
    expect(screen.getByText('SECRET CONTENT')).toBeTruthy();
  });
});
