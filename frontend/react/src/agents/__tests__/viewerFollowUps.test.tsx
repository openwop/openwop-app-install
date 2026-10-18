/**
 * ADR 0775 D1 follow-ups from the grade-ux re-grade.
 *
 *  - ARUX-15: "Remove photo" called `onSave(null)` unguarded; once a failed save
 *    was rethrown into the editor, a failed REMOVE became an unhandled rejection
 *    with nothing on screen.
 *  - ARUX-19: the viewer's read-only door kept the wizard's focus trap around a
 *    single back link — keyboard users could not leave (WCAG 2.1.2).
 *  - ARUX-16: a viewer was still offered "Check now" on every dashboard row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { access } = vi.hoisted(() => ({
  access: { current: { access: { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }, resolved: true } },
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState: () => access.current,
}));

import { AvatarEditor } from '../AvatarEditor.js';
import { AgentCreateWizard } from '../AgentCreateWizard.js';
import { RosterRow } from '../RosterRow.js';
import type { AgentView } from '../agentViewModel.js';

afterEach(cleanup);

describe('ARUX-15 — a failed photo removal is shown, not swallowed', () => {
  it('a rejecting onSave(null) renders the alert and re-enables the editor', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('You don’t have permission to do that here.'));
    render(<AvatarEditor personaName="Ada" currentAvatarUrl="data:image/png;base64,AAAA" onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove photo/i }));
    expect((await screen.findByRole('alert')).textContent).toBe('You don’t have permission to do that here.');
    expect(onSave).toHaveBeenCalledWith(null);
    await waitFor(() => expect((screen.getByRole('button', { name: /Remove photo/i }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('ARUX-19 — the viewer door does not trap focus', () => {
  // DOUBLE GUARD (honest ceiling, recorded w48): the viewer card is protected
  // twice — `useFocusTrap(canWrite)` is INACTIVE for a viewer, AND the viewer
  // branch attaches no `ref={trapRef}` (the hook no-ops on a null container).
  // Removing either one alone leaves focus free, so no single-edit sabotage can
  // red this case (w48g1-vf-trap was vacuous by construction). The probe that
  // witnesses it removes BOTH in one edit (w48g1-vf-trap-both-r2).
  it('focus is not pulled into (or held by) the read-only card', () => {
    const before = document.createElement('button');
    before.textContent = 'sidebar';
    document.body.appendChild(before);
    try {
      before.focus();
      render(<MemoryRouter><AgentCreateWizard /></MemoryRouter>);
      expect(screen.getByText(/can't create agents here/i)).toBeTruthy();
      // An active trap moves focus into its container on mount; none does here.
      expect(document.activeElement).toBe(before);
      // And Tab is not captured: an active trap's document-level listener
      // preventDefaults Tab to keep focus inside; here it must reach the browser.
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented, 'Tab must be free to leave the read-only card').toBe(false);
    } finally {
      before.remove();
    }
  });
});

describe('ARUX-16 — no Check now without a handler', () => {
  const view: AgentView = {
    entry: {
      rosterId: 'r1', persona: 'Ada', label: 'Ada', roleKey: 'engineer', autonomyLevel: 'review', agentRef: { agentId: 'a1' },
      workflows: [], tenantId: 't1', enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    },
    board: null, cards: [], laneCounts: { todo: 0, working: 0, waiting: 0, done: 0 }, status: 'active', jobs: [], nextSchedule: null, failureCheckUnavailable: false,
  };

  it('RosterRow renders no Check now control for a viewer (no onCheckNow)', () => {
    render(<MemoryRouter><RosterRow view={view} busy={false} onOpen={vi.fn()} onChat={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /Check Ada now|check.*Ada/i })).toBeNull();
  });

  it('positive control — with a handler, the Check now control renders', () => {
    render(<MemoryRouter><RosterRow view={view} busy={false} onOpen={vi.fn()} onCheckNow={vi.fn()} onChat={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Check Ada now' })).toBeTruthy();
  });
});
