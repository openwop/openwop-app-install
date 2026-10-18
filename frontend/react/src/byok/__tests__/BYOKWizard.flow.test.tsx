/**
 * ADR 0768 follow-up C1 — pin the BYOK wizard's flow BEFORE any visual refresh.
 *
 * It had no test. The rules a restyle must not lose:
 *  - provider → model (recommended pre-selected) → key; Back steps back;
 *  - the key is written INTO the provider's existing stored ref when one exists
 *    (ADR 0517 fix B — a replacement overwrites, never orphans), else `byok:<id>`;
 *  - a MANAGED provider completes at once (no key); a SUBSCRIPTION provider
 *    (ADR 0757, Copilot) skips the model + key steps;
 *  - focus lands on each new step's heading (UX ADM-4).
 * The child pickers are stubbed: this pins the ORCHESTRATION, which is what a
 * redesign of the layout touches.
 *
 * Sabotage that turns these red (BYOKWizard.tsx): no recommended pre-select, no
 * focus move, Back to the wrong step, a fresh ref instead of the stored one, the
 * managed / subscription short-circuits removed, the `managed:` sentinel dropped.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' }, signIn: vi.fn() }) }));
vi.mock('../BYOKStepper.js', () => ({ BYOKStepper: ({ current }: { current: string }) => <h2>step:{current}</h2> }));

type P = { id: string; managed?: boolean; subscription?: boolean; models: Array<{ id: string; recommended?: boolean }> };
const openai: P = { id: 'openai', models: [{ id: 'gpt-a' }, { id: 'gpt-b', recommended: true }] };
const managed: P = { id: 'demo', managed: true, models: [{ id: 'demo-model' }] };
const copilot: P = { id: 'copilot', subscription: true, models: [] };

vi.mock('../ProviderGrid.js', () => ({
  TryItFreeCard: () => null,
  ProviderGrid: ({ onPick }: { onPick: (p: P) => void }) => (
    <div>
      <button type="button" onClick={() => onPick(openai)}>pick-openai</button>
      <button type="button" onClick={() => onPick(managed)}>pick-managed</button>
      <button type="button" onClick={() => onPick(copilot)}>pick-copilot</button>
    </div>
  ),
}));
vi.mock('../ModelGrid.js', () => ({
  ModelGrid: ({ selectedModelId, onPick, onBack }: { selectedModelId?: string; onPick: (m: { id: string }) => void; onBack: () => void }) => (
    <div>
      <span>selected:{selectedModelId}</span>
      <button type="button" onClick={() => onPick({ id: selectedModelId ?? '' })}>use-model</button>
      <button type="button" onClick={onBack}>back</button>
    </div>
  ),
}));
vi.mock('../KeyEntry.js', () => ({
  KeyEntry: ({ targetRef, existingRef, onStored, onBack }: { targetRef: string; existingRef?: string; onStored: (ref: string) => Promise<void>; onBack: () => void }) => (
    <div>
      <span>target:{targetRef}</span>
      <span>existing:{existingRef ?? 'none'}</span>
      <button type="button" onClick={() => { void onStored(targetRef); }}>store</button>
      <button type="button" onClick={onBack}>back</button>
    </div>
  ),
}));

import { BYOKWizard } from '../BYOKWizard.js';

afterEach(() => cleanup());

describe('BYOKWizard flow (pinned before the C1 refresh)', () => {
  it('provider → model (recommended pre-selected) → key → complete, with Back', async () => {
    const onComplete = vi.fn();
    render(<BYOKWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByText('pick-openai'));
    expect(screen.getByText('step:model')).toBeTruthy();
    expect(screen.getByText('selected:gpt-b')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('step:model'); // focus follows the step
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByText('step:provider')).toBeTruthy();
    fireEvent.click(screen.getByText('pick-openai'));
    fireEvent.click(screen.getByText('use-model'));
    expect(screen.getByText('target:byok:openai')).toBeTruthy();
    fireEvent.click(screen.getByText('store'));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-b', credentialRef: 'byok:openai' }));
  });

  it('writes INTO an existing stored ref for the provider (ADR 0517 fix B)', () => {
    render(<BYOKWizard onComplete={vi.fn()} storedRefs={['byok:openai:work']} />);
    fireEvent.click(screen.getByText('pick-openai'));
    fireEvent.click(screen.getByText('use-model'));
    expect(screen.getByText('existing:byok:openai:work')).toBeTruthy();
    expect(screen.getByText('target:byok:openai:work')).toBeTruthy();
  });

  it('a managed provider completes at once, with no key step', async () => {
    const onComplete = vi.fn();
    render(<BYOKWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByText('pick-managed'));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // The `managed:<id>` sentinel is what routes the backend to the server-held key;
    // a bare provider id would be looked up as a tenant BYOK secret and fail.
    expect(onComplete).toHaveBeenCalledWith({ provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' });
    expect(screen.queryByText(/^target:/)).toBeNull();
  });

  it('a subscription provider (Copilot) skips the model and key steps', async () => {
    const onComplete = vi.fn();
    render(<BYOKWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByText('pick-copilot'));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // Literals, not the imported constants: the binding the host accepts is exactly this.
    expect(onComplete).toHaveBeenCalledWith({ provider: 'copilot', model: 'default', credentialRef: 'subscription:github.copilot' });
    expect(screen.queryByText('step:model')).toBeNull();
  });
});
