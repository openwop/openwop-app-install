/**
 * ADR 0779 D7 (grade-ux H2/H3) — a member without `host:byok:manage` is not led
 * into a write the server refuses, on the surfaces production actually renders:
 * the COMPACT chat-header card (its "Change" re-binds the workspace chat) and
 * the wizard's key step (it said "no permission" only AFTER a secret was pasted).
 *
 * Each read-only case has a polarity case: an admin DOES get the control, so a
 * surface that hides it from everyone cannot pass.
 *
 * Sabotage that turns these red: `{canManage ? (` forced either way in
 * ConfiguredProviderCard's compact branch; KeyEntry's read-only notice or the
 * field's `disabled={!canManage}` forced either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BYOKActiveConfig } from '../lib/useBYOKConfig.js';
import { getProvider } from '../lib/providers.js';

type AccessState = { access: { basis: string; scopes: string[] }; resolved: boolean };
const MEMBER: AccessState = { access: { basis: 'member', scopes: ['workspace:write'] }, resolved: true };
const ADMIN: AccessState = { access: { basis: 'member', scopes: ['host:byok:manage'] }, resolved: true };
const access: { current: AccessState } = { current: MEMBER };
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<object>()),
  useEffectiveAccessState: () => access.current,
}));
vi.mock('../lib/byokClient.js', () => ({ storeKey: vi.fn(), deleteKey: vi.fn(), clearActiveConfig: vi.fn() }));

const { ConfiguredProviderCard } = await import('../ConfiguredProviderCard.js');
const { KeyEntry } = await import('../KeyEntry.js');

beforeEach(() => { access.current = MEMBER; });
afterEach(cleanup);

const provider = getProvider('google');
const model = provider.models[0]!;
const config: BYOKActiveConfig = { provider: 'google', model: model.id, credentialRef: 'byok:google' };
const READ_ONLY = /Only workspace admins can add or remove AI keys/;

describe('BYOK read-only presentation', () => {
  it('the compact chat-header card offers a member no "Change"', () => {
    render(<ConfiguredProviderCard config={config} onChange={vi.fn()} onRemoved={vi.fn()} compact stored />);
    // The card itself rendered (so the absence below is not an empty render).
    expect(screen.getByText('Google')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('polarity: an admin is offered "Change"', () => {
    access.current = ADMIN;
    render(<ConfiguredProviderCard config={config} onChange={vi.fn()} onRemoved={vi.fn()} compact stored />);
    expect(screen.getByRole('button', { name: /change/i })).toBeTruthy();
  });

  it('the key step says so BEFORE a paste, and the field is disabled', () => {
    render(<KeyEntry provider={provider} model={model} onBack={vi.fn()} onStored={vi.fn()} targetRef="byok:google" />);
    expect(screen.getByText(READ_ONLY)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(/api key/i).disabled).toBe(true);
  });

  it('polarity: an admin\'s key step has an enabled field and no read-only notice', () => {
    access.current = ADMIN;
    render(<KeyEntry provider={provider} model={model} onBack={vi.fn()} onStored={vi.fn()} targetRef="byok:google" />);
    expect(screen.queryByText(READ_ONLY)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(/api key/i).disabled).toBe(false);
  });
});
