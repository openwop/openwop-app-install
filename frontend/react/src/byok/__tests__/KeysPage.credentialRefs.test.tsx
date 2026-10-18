/**
 * KEYS-REF-1 — every stored key is LISTED on the Keys page, under the provider
 * its ref names (the backend's rule), so it can be seen and deleted.
 *
 * The page used to split a ref at its first colon: the BYOK wizard's `byok:google`
 * (ADR 0517 fix B) grouped under a provider called `byok`, which no section
 * renders and which is not the unscoped bucket. The key counted in Total and
 * appeared nowhere, so it could not be deleted here, and the duplicate-key notice
 * never saw it. Break it by restoring the first-colon split in KeysPage.parseRef
 * (every case red); stop filtering card-owned refs (case 4), count one key short in
 * the duplicate notice (case 2), or delete a different ref (case 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EffectiveAccess } from '../../client/accessClient.js';

type AccessModule = typeof import('../../client/useEffectiveAccess.js');
type ByokClient = typeof import('../lib/byokClient.js');
const OWNER: EffectiveAccess = { roles: [], scopes: [], basis: 'tenant-owner' };
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<AccessModule>()),
  useEffectiveAccessState: () => ({ access: OWNER, resolved: true }),
}));
const listStoredRefs = vi.fn<ByokClient['listStoredRefs']>();
const deleteKey = vi.fn<ByokClient['deleteKey']>();
vi.mock('../lib/byokClient.js', async (orig) => ({
  ...(await orig<ByokClient>()),
  listStoredRefs: () => listStoredRefs(),
  deleteKey: (ref: string, opts?: { force?: boolean }) => deleteKey(ref, opts),
  getActiveConfig: vi.fn<ByokClient['getActiveConfig']>(async () => ({ config: null, valid: false, anonymous: false })),
  getAiDefault: vi.fn<ByokClient['getAiDefault']>(async () => null),
}));
vi.mock('../../chrome/hubContext.js', () => ({ useHub: () => ({ embedded: true }) }));
vi.mock('../SubscriptionCredentialCard.js', () => ({ SubscriptionCredentialCard: () => null }));

const { KeysPage } = await import('../KeysPage.js');

beforeEach(() => {
  listStoredRefs.mockReset();
  deleteKey.mockReset();
  deleteKey.mockResolvedValue(undefined);
});
afterEach(cleanup);

const table = (caption: string): HTMLElement => {
  const t = screen.getByText(caption, { selector: 'caption' }).closest('table');
  if (!t) throw new Error(`no table for caption ${caption}`);
  return t;
};

describe('KEYS-REF-1 — the Keys page lists every stored key', () => {
  it('a wizard key `byok:google` lists under Google (not nowhere)', async () => {
    listStoredRefs.mockResolvedValue(['byok:google']);
    render(<KeysPage />);
    await screen.findAllByText('byok:google');
    expect(within(table('Stored Google keys')).getByText('byok:google')).toBeTruthy();
    expect(screen.queryByText('Unscoped')).toBeNull();
  });

  it('the duplicate-key notice counts the wizard key with a Keys-page key of the same provider', async () => {
    listStoredRefs.mockResolvedValue(['byok:google', 'google:prod']);
    render(<KeysPage />);
    expect(await screen.findByText('2 Google keys are stored, and your chat is not bound to any of them. Pick one in the chat, or remove the ones you no longer need.')).toBeTruthy();
  });

  it('the wizard key can be deleted from the page', async () => {
    listStoredRefs.mockResolvedValue(['byok:google']);
    render(<KeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete byok:google' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(deleteKey).toHaveBeenCalledTimes(1));
    expect(deleteKey.mock.calls[0]![0]).toBe('byok:google');
  });

  it('a ref naming no listed provider is listed as Unscoped; card-owned refs are not', async () => {
    listStoredRefs.mockResolvedValue(['byok:google', 'my-key', 'byok:minimax', 'web-search', 'subscription:github.copilot']);
    render(<KeysPage />);
    await screen.findAllByText('byok:google');
    const deletable = screen.getAllByRole('button', { name: /^Delete / }).map((b) => b.getAttribute('aria-label'));
    expect(deletable.sort()).toEqual(['Delete byok:google', 'Delete byok:minimax', 'Delete my-key']);
    expect(screen.queryByRole('button', { name: 'Delete subscription:github.copilot' })).toBeNull();
  });
});
