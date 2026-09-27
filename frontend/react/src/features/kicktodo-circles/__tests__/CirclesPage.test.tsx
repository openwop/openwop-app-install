/**
 * KTUX-4/7 + screen-polish regression net — the per-circle invite control is
 * a PICKER of workspace members resolved by an accessible label (nobody types
 * an opaque subject id — the ADR 0436 §1 vocabulary rule), falling back to a
 * labeled field only when the roster is unavailable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(() => Promise.resolve([
    { id: 'm1', subject: 'user:2', displayName: 'Ada Lovelace', roles: [] },
  ])),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve([{ id: 'enr:1', challengeId: 'ch:1', state: 'active' }])),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listCircles: vi.fn(() => Promise.resolve([{ id: 'circle:1', type: 'partner', enrollmentId: 'enr:1', name: 'My circle', conversationId: 'c:1' }])),
  createCircle: vi.fn(),
  listGrants: vi.fn(() => Promise.resolve([])),
  invite: vi.fn(),
  revoke: vi.fn(),
  getFeed: vi.fn(() => Promise.resolve(null)),
}));

import { CirclesPage } from '../CirclesPage.js';
afterEach(cleanup);

describe('CirclesPage', () => {
  it('the invite control is a labeled member PICKER with people, not ids', async () => {
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);
    const picker = await waitFor(() => screen.getByRole('combobox', { name: 'Invite a workspace member' }));
    expect(picker).toBeTruthy();
    // The option is a display name; the opaque subject never renders as text.
    expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toBeTruthy();
    expect(screen.queryByText('user:2')).toBeNull();
  });
});
