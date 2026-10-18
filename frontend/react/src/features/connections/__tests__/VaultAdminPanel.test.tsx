/**
 * VaultAdminPanel (ADR 0389 P2) — render-path coverage with the client module
 * mocked (backend is the authority): a 403 (ForbiddenError) hides the panel
 * entirely; the inventory renders masked rows with reveal offered ONLY for
 * raw refs. Mutation flows (reveal/rotate/delete) are covered at the route
 * level (backend test/admin-vault.test.ts); the live enroll of values needs a
 * superadmin session and is verified there.
 *
 * The hide case waits for the loading placeholder (`role="status"`) to leave
 * before asserting emptiness — the skeleton's own textContent is '' too, so an
 * emptiness check made while loading passed for the wrong reason (wave 52). The
 * contrast case pins that a NON-403 failure is shown, so "hidden" is specific to
 * the 403. Sabotage that turns it red: dropping the `ForbiddenError` → setHidden
 * branch (the hide case shows "forbidden"), gating Reveal on `kind` instead of
 * `revealable`, or rendering the value instead of the mask.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => { mInv.mockReset(); });

describe('VaultAdminPanel', () => {
  it('HIDES itself for a non-superadmin (backend 403 → ForbiddenError)', async () => {
    mInv.mockRejectedValue(new MockForbiddenError('forbidden'));
    const { container } = render(<VaultAdminPanel />);
    // Settle: the loading placeholder is gone (its skeleton text is '' as well).
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
    expect(container.textContent).toBe(''); // hidden entirely
    expect(screen.queryByText('forbidden')).toBeNull();
  });

  it('a NON-403 load failure is shown, not hidden like a 403 (contrast)', async () => {
    mInv.mockRejectedValue(new Error('vault read 503'));
    render(<VaultAdminPanel />);
    expect(await screen.findByText('vault read 503')).toBeTruthy();
  });

  it('renders masked rows; reveal only for revealable (raw) refs', async () => {
    mInv.mockResolvedValue({
      tenantSecrets: [
        { credentialRef: 'my-key', kind: 'raw' as const, revealable: true },
        { credentialRef: 'connection:c1', kind: 'connection-token' as const, revealable: false },
      ],
      hostSecrets: [],
      connections: [], oauthClients: [], apiKeys: [],
    });
    render(<VaultAdminPanel />);
    await waitFor(() => expect(screen.getByText('my-key')).toBeTruthy());
    expect(screen.getByText('connection:c1')).toBeTruthy();
    // Exactly ONE reveal button (the raw ref); the connection token gets none.
    expect(screen.getAllByRole('button', { name: /^Reveal — /i })).toHaveLength(1); // per-row aria-label (grade-ux UX-7)
    // Values are masked.
    expect(screen.getAllByText('••••••••').length).toBe(2);
  });
});
