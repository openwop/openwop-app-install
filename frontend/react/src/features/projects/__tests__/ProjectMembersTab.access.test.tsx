import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { Project } from '../projectsClient.js';

/**
 * ADR 0063 — the project write-gate. Proves ProjectMembersTab renders its write
 * affordances (Add / Remove / the visibility toggle) ONLY for a writer; a
 * non-writer (`canWrite={false}`) sees the roster read-only. The FE gate is a UX
 * hint — the backend still enforces — so this guards the affordance visibility,
 * not authority.
 */
vi.mock('../projectsClient.js', () => ({
  listProjectMembers: vi.fn(async () => ({
    members: [{ ref: 'user:u1', role: 'contributor', addedAt: '2026-01-01T00:00:00Z' }],
    visibility: 'org',
  })),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  setProjectVisibility: vi.fn(),
}));
vi.mock('../../../client/accessClient.js', () => ({
  listMembers: vi.fn(async () => [{ subject: 'u1', displayName: 'Alice' }]),
}));
vi.mock('../../../agents/rosterClient.js', () => ({
  listRoster: vi.fn(async () => []),
}));

import { ProjectMembersTab } from '../ProjectMembersTab.js';

const project: Project = { id: 'p1', tenantId: 't', orgId: 'o1', name: 'P', workflows: [], boardId: 'b1' };

afterEach(cleanup);

describe('ProjectMembersTab — write-control gating (ADR 0063)', () => {
  it('a writer sees Add + Remove + an enabled visibility toggle', async () => {
    render(<ProjectMembersTab project={project} canWrite={true} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText('Add to the team')).toBeTruthy());
    expect(screen.getByLabelText('Remove Alice')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Org-visible' }).hasAttribute('disabled')).toBe(false);
  });

  it('a non-writer sees the roster but NO Add / Remove and a disabled visibility toggle', async () => {
    render(<ProjectMembersTab project={project} canWrite={false} onSaved={() => {}} />);
    // The roster still loads (Alice is shown) — only the write controls are gone.
    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy());
    expect(screen.queryByText('Add to the team')).toBeNull();
    expect(screen.queryByLabelText('Remove Alice')).toBeNull();
    expect(screen.getByRole('button', { name: 'Org-visible' }).hasAttribute('disabled')).toBe(true);
  });
});
