/**
 * ADR 0775 P3 (`ARUX-18`) — the agent workspace's edit panels are read-only for
 * a viewer. Before this a viewer was offered the Instructions editor, the
 * Guardrails Add/Edit, the Voice form and the portfolio's assign/remove, and
 * learned only on save (an honest 403 by then, but after the typing).
 *
 * Each case renders the same panel as a viewer and as an editor, so a pass is
 * never just "the control was never there".
 *
 * Sabotage-witnessed (wave 51): `canWriteAgents` returning true for a member
 * without `workspace:write` reds every viewer case; each panel's own `canWrite`
 * branch (Instructions prompt editor + read-only line, Guardrails Add AND Edit,
 * Voice provider field + Save, portfolio assign AND Unassign) reds its own case.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EffectiveAccess } from '../../client/accessClient.js';
import type { AgentProfile, RosterEntry } from '../rosterClient.js';

type AccessState = { access: EffectiveAccess; resolved: boolean };
type RosterClient = typeof import('../rosterClient.js');
type WfClient = typeof import('../../workflows/workflowsClient.js');
type ByokClient = typeof import('../../byok/lib/byokClient.js');

const VIEWER: AccessState = { access: { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }, resolved: true };
const EDITOR: AccessState = { access: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' }, resolved: true };
const { access, getAgentProfile, listWorkflowSummaries } = vi.hoisted(() => ({
  access: { current: null as AccessState | null },
  getAgentProfile: vi.fn<RosterClient['getAgentProfile']>(),
  listWorkflowSummaries: vi.fn<WfClient['listWorkflowSummaries']>(),
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState: (): AccessState => {
    if (!access.current) throw new Error('set the caller with as() first');
    return access.current;
  },
}));
vi.mock('../rosterClient.js', async (orig) => ({ ...(await orig<RosterClient>()), getAgentProfile }));
vi.mock('../../byok/lib/byokClient.js', async (orig) => ({
  ...(await orig<ByokClient>()),
  listStoredRefs: vi.fn<ByokClient['listStoredRefs']>(async () => []),
}));
vi.mock('../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<WfClient>()),
  listWorkflowSummaries,
  getWorkflowAvailability: vi.fn<WfClient['getWorkflowAvailability']>(async () => new Map()),
}));

import { AgentInstructionsPanel } from '../AgentInstructionsPanel.js';
import { AgentGuardrailsPanel } from '../AgentGuardrailsPanel.js';
import { AgentVoicePanel } from '../AgentVoicePanel.js';
import { AgentWorkflowPortfolioPanel } from '../AgentWorkflowPortfolioPanel.js';

const entry: RosterEntry = {
  rosterId: 'host:ada', persona: 'Ada', agentRef: { agentId: 'user.ada', channel: 'stable' }, workflows: [], tenantId: 't', enabled: true,
  description: 'Reviews invoices.', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
/** The same agent with one assigned workflow, so the portfolio renders a card (and its Unassign). */
const entryWithWorkflow: RosterEntry = { ...entry, workflows: ['wf.quarterly-board-pack'] };
/** A stored guardrails profile, so the panel renders its edit bar (not the "none" card). */
const PROFILE: AgentProfile = {
  profileId: 'p-ada', tenantId: 't', roleKey: 'reviewer',
  autonomy: { level: 'review', specLevel: 'recommend' },
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const READONLY = /You can view this agent/;

afterEach(cleanup);
beforeEach(() => {
  getAgentProfile.mockReset();
  listWorkflowSummaries.mockReset();
  getAgentProfile.mockResolvedValue(null);
  listWorkflowSummaries.mockResolvedValue([]);
  access.current = null;
});

const as = (who: AccessState): void => { access.current = who; };

describe('Instructions', () => {
  it('a viewer reads the description; no editor, no save buttons', () => {
    as(VIEWER);
    render(<MemoryRouter><AgentInstructionsPanel entry={entry} onChanged={vi.fn()} /></MemoryRouter>);
    expect(screen.getAllByText(READONLY).length).toBeGreaterThan(0);
    expect(screen.getByText('Reviews invoices.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save/i })).toBeNull();
  });
  it('an editor gets the save buttons (control)', () => {
    as(EDITOR);
    render(<MemoryRouter><AgentInstructionsPanel entry={entry} onChanged={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByText(READONLY)).toBeNull();
    expect(screen.getAllByRole('button', { name: /Save/i }).length).toBeGreaterThan(0);
  });
});

describe('Guardrails', () => {
  it('a viewer is not offered Add guardrails', async () => {
    as(VIEWER);
    render(<AgentGuardrailsPanel rosterId="host:ada" persona="Ada" />);
    // Settled on the "none" card — not still loading, not an error.
    expect(await screen.findByText('No guardrails yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add/i })).toBeNull();
  });
  it('an editor is (control)', async () => {
    as(EDITOR);
    render(<AgentGuardrailsPanel rosterId="host:ada" persona="Ada" />);
    expect(await screen.findByRole('button', { name: /Add/i })).toBeTruthy();
  });
  it('a viewer of STORED guardrails is told they are read-only, and not offered Edit profile', async () => {
    as(VIEWER);
    getAgentProfile.mockResolvedValue(PROFILE);
    render(<AgentGuardrailsPanel rosterId="host:ada" persona="Ada" />);
    expect(await screen.findByText(READONLY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  });
  it('an editor of stored guardrails gets Edit profile (control)', async () => {
    as(EDITOR);
    getAgentProfile.mockResolvedValue(PROFILE);
    render(<AgentGuardrailsPanel rosterId="host:ada" persona="Ada" />);
    expect(await screen.findByRole('button', { name: 'Edit profile' })).toBeTruthy();
    expect(screen.queryByText(READONLY)).toBeNull();
  });
});

describe('Voice', () => {
  it('a viewer sees disabled fields and no Save', async () => {
    as(VIEWER);
    render(<AgentVoicePanel rosterId="host:ada" />);
    await waitFor(() => expect(getAgentProfile).toHaveBeenCalled());
    expect(screen.getByText(READONLY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save/i })).toBeNull();
    const fields = screen.getAllByRole('combobox');
    expect(fields).toHaveLength(1); // the provider select (the key select needs a BYOK provider)
    for (const el of fields) expect(el instanceof HTMLSelectElement && el.disabled).toBe(true);
  });
  it('an editor gets Save (control)', async () => {
    as(EDITOR);
    render(<AgentVoicePanel rosterId="host:ada" />);
    expect(await screen.findByRole('button', { name: /Save/i })).toBeTruthy();
  });
});

describe('Workflow portfolio', () => {
  it('a viewer has no assign control, and no Unassign on an assigned workflow', async () => {
    as(VIEWER);
    render(<MemoryRouter><AgentWorkflowPortfolioPanel entry={entryWithWorkflow} onChanged={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText(READONLY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy(); // the card rendered
    expect(screen.queryByRole('button', { name: /Assign/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unassign' })).toBeNull();
  });
  it('an editor does (control)', async () => {
    as(EDITOR);
    render(<MemoryRouter><AgentWorkflowPortfolioPanel entry={entryWithWorkflow} onChanged={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Assign workflow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unassign' })).toBeTruthy();
  });
});
