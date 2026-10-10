/**
 * ADR 0852 D6 — the campaign's team ledger section.
 *
 *   - a linked campaign renders the SAME project Ledger UI for its project;
 *   - an unlinked campaign offers "Set up", which creates-or-returns the
 *     project and then renders its ledger; a failed setup is said;
 *   - a failed read is said, never shown as "no ledger".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const h = vi.hoisted(() => ({
  enabled: true,
  getCampaign: vi.fn(),
  ensureCampaignProject: vi.fn(),
  getProject: vi.fn(),
}));
vi.mock('../campaignStudioClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getCampaign: h.getCampaign, ensureCampaignProject: h.ensureCampaignProject }));
vi.mock('../../projects/projectsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getProject: h.getProject }));
vi.mock('../../projects/ProjectLedgerTab.js', () => ({
  ProjectLedgerTab: ({ project, canWrite }: { project: { id: string }; canWrite: boolean }) => <div data-testid="ledger">{`ledger:${project.id}:${String(canWrite)}`}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: h.enabled }) }));

import { CampaignLedgerSection } from '../CampaignLedgerSection.js';

beforeEach(() => {
  h.enabled = true;
  for (const f of [h.getCampaign, h.ensureCampaignProject, h.getProject]) f.mockReset();
  h.getProject.mockImplementation(async (id: string) => ({ id, canWrite: true }));
});
afterEach(cleanup);

describe('CampaignLedgerSection', () => {
  it('a linked campaign renders the project ledger for its project', async () => {
    h.getCampaign.mockResolvedValue({ id: 'c1', projectId: 'p9' });
    render(<CampaignLedgerSection campaignId="c1" />);
    expect((await screen.findByTestId('ledger')).textContent).toBe('ledger:p9:true');
    expect(screen.getByRole('region', { name: 'Team ledger' })).toBeTruthy();
  });

  it('an unlinked campaign offers Set up; it creates-or-returns the project, then shows its ledger', async () => {
    h.getCampaign.mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 'c1', projectId: 'p2' });
    h.ensureCampaignProject.mockResolvedValue('p2');
    render(<CampaignLedgerSection campaignId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the team ledger' }));
    await waitFor(() => expect(h.ensureCampaignProject).toHaveBeenCalledWith('c1'));
    expect((await screen.findByTestId('ledger')).textContent).toBe('ledger:p2:true');
  });

  it('a failed setup is said, and the campaign stays unlinked', async () => {
    h.getCampaign.mockResolvedValue({ id: 'c1' });
    h.ensureCampaignProject.mockRejectedValue(new Error('403'));
    render(<CampaignLedgerSection campaignId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the team ledger' }));
    expect(await screen.findByText(/could not be set up/)).toBeTruthy();
    expect(screen.queryByTestId('ledger')).toBeNull();
  });

  it('a failed read is said, not shown as "no ledger"', async () => {
    h.getCampaign.mockRejectedValue(new Error('503'));
    render(<CampaignLedgerSection campaignId="c1" />);
    expect((await screen.findAllByText(/could not be loaded/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Set up the team ledger' })).toBeNull();
  });
});
