/**
 * ADR 0775 D1 — the presentation of the agent-area write authority.
 *
 * `canWriteAgents` must FAIL OPEN: the server judges a person by both identity
 * spellings while `/access/effective` reads one, so the UI hides write controls
 * only for a resolved member that plainly lacks `workspace:write`. And the
 * create wizard refuses a viewer at the door (grade-ux ARUX-1) instead of after
 * five steps with a raw `→ 403`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { canWriteAgents, isWriteRefusal, writeErrorMessage } from '../agentWriteAccess.js';
import { ApiError } from '../../client/errorEnvelope.js';

type AccessState = { access: { roles: string[]; scopes: string[]; basis: string }; resolved: boolean };
const VIEWER: AccessState = { access: { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }, resolved: true };
const EDITOR: AccessState = { access: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' }, resolved: true };
const { access } = vi.hoisted(() => ({
  access: { current: { access: { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }, resolved: true } as { access: { roles: string[]; scopes: string[]; basis: string }; resolved: boolean } },
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState: () => access.current,
}));

import { AgentCreateWizard } from '../AgentCreateWizard.js';

afterEach(() => { cleanup(); access.current = VIEWER; });

describe('canWriteAgents — fail-open presentation', () => {
  it('hides only for a resolved member without workspace:write', () => {
    expect(canWriteAgents({ basis: 'member', scopes: ['workspace:read'] }, true)).toBe(false);
    expect(canWriteAgents({ basis: 'member', scopes: ['workspace:write'] }, true)).toBe(true);
    expect(canWriteAgents({ basis: 'member', scopes: [] }, false), 'still resolving').toBe(true);
    expect(canWriteAgents({ basis: 'none', scopes: [] }, true), 'the read failed').toBe(true);
    expect(canWriteAgents({ basis: 'tenant-owner', scopes: [] }, true)).toBe(true);
    expect(canWriteAgents({ basis: 'member', scopes: [], superadmin: true }, true)).toBe(true);
  });
});

describe('writeErrorMessage — a refusal reads as a permission line, never as a status code', () => {
  it('maps the status-carrying and the status-dropping 403 shapes', () => {
    expect(isWriteRefusal(new ApiError('Missing required scope: workspace:write', 403, 'Missing required scope: workspace:write'))).toBe(true);
    expect(isWriteRefusal(new ApiError('Profile not found', 404, 'Profile not found'))).toBe(false);
    expect(isWriteRefusal(new Error('deleteRosterEntry returned 403'))).toBe(true);
    // A bare message is NOT a refusal: status is the only key (openwop-app#4223
    // made every in-scope client throw a status-carrying ApiError).
    expect(isWriteRefusal(new Error('Missing required scope: workspace:write'))).toBe(false);
    expect(writeErrorMessage(new Error('updateRosterEntry returned 403'), 'NO-PERMISSION')).toBe('NO-PERMISSION');
    expect(writeErrorMessage(new Error('updateRosterEntry returned 500'), 'NO-PERMISSION')).toBe('updateRosterEntry returned 500');
  });
});

describe('the create wizard refuses a viewer at the door (grade-ux ARUX-1)', () => {
  it('a viewer sees why, and no wizard step', () => {
    access.current = VIEWER;
    render(<MemoryRouter><AgentCreateWizard /></MemoryRouter>);
    expect(screen.getByText(/can't create agents here/i)).toBeTruthy();
    expect(screen.queryByText('Pick a role')).toBeNull();
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
  });

  it('positive control — an editor gets the wizard and no refusal card', () => {
    access.current = EDITOR;
    render(<MemoryRouter><AgentCreateWizard /></MemoryRouter>);
    expect(screen.getByText('Pick a role')).toBeTruthy();
    expect(screen.queryByText(/can't create agents here/i)).toBeNull();
  });
});
