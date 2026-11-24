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
 * focus move, Back to the wrong step (from the model step OR the key step), a
 * fresh ref instead of the stored one, the managed / subscription short-circuits
 * removed, the `managed:` sentinel dropped (re-probed wave 117).
 * 2026-11-09: the StrictMode mount case goes red when the step-focus effect skips
 * its first run with a flag instead of comparing with the last focused step.
 *
 * TST-OAH-3 (2026-11-22, user decision): the signed-out managed path. Red when the
 * provider is not stashed before sign-in, sign-in is not started, the resume effect
 * does not complete with the `managed:` sentinel, leaves the stash behind, or
 * accepts a stashed id that is not a managed provider.
 */
import { StrictMode } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// Signed in by default; the TST-OAH-3 cases sign out (or return from the redirect).
const auth = vi.hoisted(() => ({ user: { uid: 'u1' } as { uid: string } | null, google: vi.fn() }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: auth.user, signIn: { google: auth.google } }) }));
vi.mock('../BYOKStepper.js', () => ({ BYOKStepper: ({ current }: { current: string }) => <h2>step:{current}</h2> }));

type P = { id: string; managed?: boolean; subscription?: boolean; models: Array<{ id: string; recommended?: boolean }> };
const openai: P = { id: 'openai', models: [{ id: 'gpt-a' }, { id: 'gpt-b', recommended: true }] };
const managed: P = { id: 'demo', managed: true, models: [{ id: 'demo-model' }] };
const copilot: P = { id: 'copilot', subscription: true, models: [] };

vi.mock('../ProviderGrid.js', () => ({
  TryItFreeCard: ({ onPick }: { onPick: (p: P) => void }) => (
    <button type="button" onClick={() => onPick(managed)}>try-free</button>
  ),
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
import { PROVIDERS } from '../lib/providers.js';

const PENDING = 'openwop-app.byok.pendingManaged';
afterEach(() => { cleanup(); auth.user = { uid: 'u1' }; auth.google.mockReset(); localStorage.removeItem(PENDING); });

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
    expect(document.activeElement?.textContent).toBe('step:key'); // focus follows to the key step too
    // Back from the key step lands on the MODEL step (not the provider grid),
    // with the chosen model still selected.
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByText('step:model')).toBeTruthy();
    expect(screen.getByText('selected:gpt-b')).toBeTruthy();
    fireEvent.click(screen.getByText('use-model'));
    fireEvent.click(screen.getByText('store'));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-b', credentialRef: 'byok:openai' }));
  });

  it('mounting never takes focus, even under StrictMode\'s double effect run; a real step change still does', () => {
    // The e2e lane runs the dev server under StrictMode. A "skip the first run"
    // flag survived the replayed mount effect and focused the heading on mount,
    // stealing focus from the page at whatever moment the wizard mounted.
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    try {
      outside.focus();
      render(<StrictMode><BYOKWizard onComplete={vi.fn()} /></StrictMode>);
      expect(screen.getByText('step:provider')).toBeTruthy();
      expect(document.activeElement).toBe(outside);
      fireEvent.click(screen.getByText('pick-openai'));
      expect(document.activeElement?.textContent).toBe('step:model');
    } finally {
      outside.remove();
    }
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
    // Synchronous, on the value: the short-circuit never leaves the provider step.
    expect(screen.getByText('step:provider')).toBeTruthy();
    expect(screen.queryByText('step:model')).toBeNull();
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
    // Synchronous, on the value: the short-circuit never leaves the provider step.
    expect(screen.getByText('step:provider')).toBeTruthy();
    expect(screen.queryByText('step:model')).toBeNull();
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // Literals, not the imported constants: the binding the host accepts is exactly this.
    expect(onComplete).toHaveBeenCalledWith({ provider: 'copilot', model: 'default', credentialRef: 'subscription:github.copilot' });
    expect(screen.queryByText('step:model')).toBeNull();
  });
});

// TST-OAH-3 (2026-11-22, user decision): the signed-out "Try it free" path had no case.
describe('BYOKWizard — the managed path for a signed-out visitor', () => {
  it('stashes the picked provider and starts sign-in, completing nothing yet', async () => {
    auth.user = null;
    const onComplete = vi.fn();
    render(<BYOKWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByText('try-free'));
    await vi.waitFor(() => expect(auth.google).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(PENDING)).toBe('demo');
    // A signed-out visitor has no session to bind a managed ref to.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('after the redirect, a signed-in mount resumes it: completes with `managed:<id>` and clears the stash', async () => {
    const real = PROVIDERS.find((p) => p.managed && p.models.length > 0);
    expect(real, 'the catalog ships a managed provider with a model').toBeTruthy();
    localStorage.setItem(PENDING, real!.id);
    const onComplete = vi.fn();
    render(<BYOKWizard onComplete={onComplete} />);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith({ provider: real!.id, model: real!.models[0]!.id, credentialRef: `managed:${real!.id}` });
    // Cleared, so the next visit to the wizard does not complete on its own again.
    expect(localStorage.getItem(PENDING)).toBeNull();
    expect(auth.google).not.toHaveBeenCalled();
  });

  it('a stashed id that is not a managed provider is cleared and completes nothing', async () => {
    const byok = PROVIDERS.find((p) => !p.managed);
    expect(byok).toBeTruthy();
    localStorage.setItem(PENDING, byok!.id);
    const onComplete = vi.fn();
    render(<BYOKWizard onComplete={onComplete} />);
    await vi.waitFor(() => expect(localStorage.getItem(PENDING)).toBeNull());
    expect(onComplete).not.toHaveBeenCalled();
  });
});
