/**
 * ADR 0779 D7 (grade-ux H2/H3) — a member without `host:byok:manage` is not led
 * into a write the server refuses, on the surfaces production actually renders:
 * the COMPACT chat-header card (its "Change" re-binds the workspace chat) and
 * the wizard's key step (it said "no permission" only AFTER a secret was pasted).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const access = { current: { access: { basis: 'member', scopes: ['workspace:write'] as string[] }, resolved: true } };
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<object>()),
  useEffectiveAccessState: () => access.current,
}));
vi.mock('../lib/byokClient.js', () => ({ storeKey: vi.fn(), deleteKey: vi.fn(), clearActiveConfig: vi.fn() }));

const { ConfiguredProviderCard } = await import('../ConfiguredProviderCard.js');
const { KeyEntry } = await import('../KeyEntry.js');

afterEach(cleanup);

const config = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' } as never;
const provider = { id: 'google', label: 'Google', apiKeyPrefix: 'AIza', apiKeyConsoleUrl: 'https://x', models: [] } as never;
const model = { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' } as never;

describe('BYOK read-only presentation', () => {
  it('the compact chat-header card offers a member no "Change"', () => {
    render(<ConfiguredProviderCard config={config} onChange={vi.fn()} onRemoved={vi.fn()} compact stored />);
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('polarity: an admin is offered "Change"', () => {
    access.current = { access: { basis: 'member', scopes: ['host:byok:manage'] }, resolved: true };
    render(<ConfiguredProviderCard config={config} onChange={vi.fn()} onRemoved={vi.fn()} compact stored />);
    expect(screen.getByRole('button', { name: /change/i })).toBeTruthy();
    access.current = { access: { basis: 'member', scopes: ['workspace:write'] }, resolved: true };
  });

  it('the key step says so BEFORE a paste, and the field is disabled', () => {
    render(<KeyEntry provider={provider} model={model} onBack={vi.fn()} onStored={vi.fn()} targetRef="byok:google" />);
    expect(screen.getByText(/Only workspace admins can add or remove AI keys/)).toBeTruthy();
    expect((screen.getByLabelText(/api key/i) as HTMLInputElement).disabled).toBe(true);
  });
});
