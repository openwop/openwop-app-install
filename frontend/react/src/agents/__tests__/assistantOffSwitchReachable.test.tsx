/**
 * AST-UX-2 — the assistant's off switch must be reachable by CAPABILITY.
 *
 * The defect: `RecurringTasksPanel` (pause a perception loop) + `AgentHealthPanel`
 * (read action health) rendered only under `entry.roleKey === 'chief-of-staff'`,
 * while the backend resolves the acting assistant agent purely by the `assistant`
 * capability (`features/assistant/capability.ts`). Activate the capability on any
 * other agent and the loops keep drafting and sending on their cron with no
 * reachable pause control.
 *
 * Four cases, because the gate is a UNION and each arm has to be shown to matter
 * independently — a single "it renders" case would pass with either arm deleted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const getAgentProfile = vi.fn();
vi.mock('../rosterClient.js', () => ({
  getAgentProfile: (...a: unknown[]) => getAgentProfile(...a),
  checkAgent: vi.fn(),
  deleteRosterEntry: vi.fn(),
  updateRosterEntry: vi.fn(),
}));

// The two panels are self-fetching; stub them to markers so this test asserts the
// GATE, not their internals (which have their own coverage).
vi.mock('../RecurringTasksPanel.js', () => ({ RecurringTasksPanel: () => <div data-testid="loops-panel" /> }));
vi.mock('../AgentHealthPanel.js', () => ({ AgentHealthPanel: () => <div data-testid="health-panel" /> }));

const { AssistantControlPanels } = await import('../AgentWorkspacePage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderPanels = (roleKey?: string) =>
  render(<AssistantControlPanels rosterId="ros-1" roleKey={roleKey} persona="Nyx" />);

describe('AST-UX-2 — the loops/health control surface is capability-gated', () => {
  it('renders for a capability-activated agent whose roleKey is NOT chief-of-staff', async () => {
    getAgentProfile.mockResolvedValue({ roleKey: 'operations-lead', capabilities: ['assistant'] });
    renderPanels('operations-lead');
    // This is the whole finding: before the fix this assertion was impossible to
    // satisfy — the panels were unreachable for every non-`chief-of-staff` agent.
    await screen.findByTestId('loops-panel');
    expect(screen.getByTestId('health-panel')).toBeTruthy();
  });

  it('renders for the seeded chief-of-staff whose capability flag was never self-healed', async () => {
    // The bootstrap-fallback arm. `ensureAssistantAgent` only activates the flag
    // the first time the tenant enqueues an action or enables a loop, so a tenant
    // seeded before the flag has a chief-of-staff with NO capabilities. Gating on
    // the capability ALONE would have taken the panels away from them — a
    // narrowing dressed as a fix.
    getAgentProfile.mockResolvedValue({ roleKey: 'chief-of-staff', capabilities: [] });
    renderPanels('chief-of-staff');
    await screen.findByTestId('loops-panel');
  });

  it('renders nothing for an ordinary agent with neither the capability nor the roleKey', async () => {
    getAgentProfile.mockResolvedValue({ roleKey: 'sales-rep', capabilities: ['knowledge'] });
    const { container } = renderPanels('sales-rep');
    await waitFor(() => expect(getAgentProfile).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="loops-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="health-panel"]')).toBeNull();
  });

  it('treats an unreadable profile as "capability unproven" rather than erroring', async () => {
    getAgentProfile.mockRejectedValue(new Error('boom'));
    const { container } = renderPanels('sales-rep');
    await waitFor(() => expect(getAgentProfile).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="loops-panel"]')).toBeNull();
  });
});
