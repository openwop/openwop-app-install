/**
 * VaultAdminPanel (ADR 0389 P2) — render-path coverage with the client module
 * mocked (backend is the authority): a 403 (ForbiddenError) hides the panel
 * entirely; the inventory renders masked rows with reveal offered ONLY for
 * raw refs. Mutation flows (reveal/rotate/delete) are covered at the route
 * level (backend test/admin-vault.test.ts); the live enroll of values needs a
 * superadmin session and is verified there.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { MockForbiddenError } = vi.hoisted(() => {
  class MockForbiddenError extends Error {}
  return { MockForbiddenError };
});
vi.mock('../connectionsClient.js', () => ({
  ForbiddenError: MockForbiddenError,
  StepUpRequiredError: class extends Error {},
  VaultReferencesError: class extends Error {},
  getVaultInventory: vi.fn(),
  vaultAddSecret: vi.fn(),
  vaultRevealSecret: vi.fn(),
  vaultRotateSecret: vi.fn(),
  vaultDeleteSecret: vi.fn(),
}));
import { VaultAdminPanel } from '../VaultAdminPanel.js';
import { getVaultInventory } from '../connectionsClient.js';
const mInv = vi.mocked(getVaultInventory);

describe('VaultAdminPanel', () => {
  it('HIDES itself for a non-superadmin (backend 403 → ForbiddenError)', async () => {
    mInv.mockImplementation(async () => { throw new MockForbiddenError('forbidden'); });
    const { container } = render(<VaultAdminPanel />);
    await waitFor(() => expect(mInv).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe('')); // hidden entirely
  });

  it('renders masked rows; reveal only for raw refs', async () => {
    mInv.mockImplementation(async () => ({
      tenantSecrets: [
        { credentialRef: 'my-key', kind: 'raw' as const, revealable: true },
        { credentialRef: 'connection:c1', kind: 'connection-token' as const, revealable: false },
      ],
      hostSecrets: [],
      connections: [], oauthClients: [], apiKeys: [],
    }));
    render(<VaultAdminPanel />);
    await waitFor(() => expect(screen.getByText('my-key')).toBeTruthy());
    expect(screen.getByText('connection:c1')).toBeTruthy();
    // Exactly ONE reveal button (the raw ref); the connection token gets none.
    expect(screen.getAllByRole('button', { name: /^Reveal — /i })).toHaveLength(1); // per-row aria-label (grade-ux UX-7)
    // Values are masked.
    expect(screen.getAllByText('••••••••').length).toBe(2);
  });
});
