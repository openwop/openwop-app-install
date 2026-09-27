/** CollabPresence cluster (ADR 0359 Phase 4) — presentational states. */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CollabPresence } from '../CollabPresence.js';
import type { CollabPeer } from '../useCollabPresence.js';

const peer = (clientId: number, name: string): CollabPeer => ({ clientId, name, sel: null, frame: null });

describe('CollabPresence', () => {
  it('solo-live: Live chip only, no avatars', () => {
    render(<CollabPresence peers={[]} connected />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(document.querySelectorAll('.cv-presence__peer').length).toBe(0);
  });

  it('peers present: ≤4 stacked avatars + an overflow chip, names on the group label', () => {
    const peers = [peer(1, 'Ana'), peer(2, 'Bo'), peer(3, 'Cy'), peer(4, 'Di'), peer(5, 'Ed'), peer(6, 'Fi')];
    render(<CollabPresence peers={peers} connected />);
    expect(document.querySelectorAll('.cv-presence__peer').length).toBe(4);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain('Ana');
  });

  it('disconnected: muted Reconnecting state', () => {
    render(<CollabPresence peers={[]} connected={false} />);
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
    expect(document.querySelector('.cv-presence__dot--off')).toBeTruthy();
  });
});

/**
 * RTCU-5 — the group's accessible NAME used to branch on peer COUNT alone, so a
 * disconnected session was still labelled "Live"/"Live session": a screen-reader
 * user querying the cluster during a drop heard the OPPOSITE of what the visible
 * chip said and of what the socket was doing. Silence would have been better; an
 * incorrect claim is worse than none.
 */
describe('CollabPresence — the group label tracks the SOCKET, not the peer count (RTCU-5)', () => {
  const label = (): string => screen.getByRole('group').getAttribute('aria-label') ?? '';

  it('disconnected WITH peers: the label says reconnecting and never claims "Live session"', () => {
    render(<CollabPresence peers={[peer(1, 'Ana'), peer(2, 'Bo')]} connected={false} />);
    expect(label()).toContain('Reconnecting');
    expect(label()).not.toContain('Live session');
    expect(label(), 'the peers are still named — the drop hides state, not who is here').toContain('Ana');
  });

  it('disconnected with NO peers: the label is the reconnecting state, not "Live"', () => {
    render(<CollabPresence peers={[]} connected={false} />);
    expect(label()).toContain('Reconnecting');
    expect(label()).not.toBe('Live');
  });

  it('connected is UNCHANGED in both shapes (positive control against a dead cure)', () => {
    const { unmount } = render(<CollabPresence peers={[]} connected />);
    expect(label()).toBe('Live');
    unmount();
    render(<CollabPresence peers={[peer(1, 'Ana')]} connected />);
    expect(label()).toContain('Live session');
    expect(label()).toContain('Ana');
  });
});
