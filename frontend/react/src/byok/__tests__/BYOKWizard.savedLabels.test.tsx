/** BYOK-1 (ADR 0517 correction): Keys-page labels must be adoptable through the actual
 * wizard key step. Metadata-only component diagnostic; no key entry, storage or provider calls.
 * The `<provider>s:zz-overlap` distractor sorts FIRST if the provider filter ever
 * prefix-matches (refsForProvider reverse-sorts), so a leak picks the wrong key.
 * Sabotage-witnessed (w93): dropping the labeled `<provider>:` match; prefix-matching
 * the provider; storing again on adopt; no existingRef from the wizard; an enabled
 * adopt control or no read-only notice for a member without write access. */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, type ProviderConfig, type ProviderModel } from '../lib/providers.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'qa' }, signIn: vi.fn() }) }));
const { storeKey, canManage } = vi.hoisted(() => ({ storeKey: vi.fn(), canManage: { value: true } }));
vi.mock('../lib/byokClient.js', () => ({ storeKey, listStoredRefs: vi.fn(), getActiveConfig: vi.fn(), putActiveConfig: vi.fn(), clearActiveConfig: vi.fn() }));
vi.mock('../lib/byokWriteAccess.js', () => ({ useByokWriteAccess: () => canManage.value, byokErrorMessage: (_t: unknown, e: Error) => e.message }));
vi.mock('../ProviderGrid.js', async () => {
  const { PROVIDERS } = await import('../lib/providers.js');
  return { TryItFreeCard: () => null, ProviderGrid: ({ onPick }: { onPick: (p: ProviderConfig) => void }) => <>{PROVIDERS.filter(p => ['google', 'anthropic'].includes(p.id)).map(p => <button key={p.id} onClick={() => onPick(p)}>pick-{p.id}</button>)}</> };
});
vi.mock('../ModelGrid.js', () => ({ ModelGrid: ({ provider, onPick }: { provider: ProviderConfig; onPick: (m: ProviderModel) => void }) => <button onClick={() => onPick(provider.models[0]!)}>use-model</button> }));
import { BYOKWizard } from '../BYOKWizard.js';
afterEach(() => { cleanup(); vi.clearAllMocks(); canManage.value = true; });
describe('BYOK-1 saved labeled key adoption', () => {
  it.each(['google', 'anthropic'] as const)('offers and adopts a Keys-page %s ref without storing a new key', async provider => {
    const onComplete = vi.fn();
    const ref = `${provider}:qa-team`;
    render(<BYOKWizard onComplete={onComplete} storedRefs={[ref, `${provider}s:zz-overlap`, 'google-vertex:foreign']} />);
    fireEvent.click(screen.getByRole('button', { name: `pick-${provider}` }));
    fireEvent.click(screen.getByRole('button', { name: 'use-model' }));
    fireEvent.click(screen.getByRole('button', { name: 'savedKeyUse' }));
    // The mocked ModelGrid picks the provider's first catalog model.
    const model = getProvider(provider).models[0]?.id;
    if (!model) throw new Error('Provider catalog has no model');
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ provider, model, credentialRef: ref })));
    expect(storeKey).not.toHaveBeenCalled();
    expect(screen.getByLabelText('apiKeyLabel')).toHaveValue('');
  });
  it('preserves member write refusal even when a labeled key exists', () => {
    canManage.value = false;
    render(<BYOKWizard onComplete={vi.fn()} storedRefs={['google:qa-team']} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick-google' }));
    fireEvent.click(screen.getByRole('button', { name: 'use-model' }));
    expect(screen.getByRole('button', { name: 'savedKeyUse' })).toBeDisabled();
    expect(screen.getByText('readOnlyNotice')).toBeVisible();
    expect(storeKey).not.toHaveBeenCalled();
  });
});
