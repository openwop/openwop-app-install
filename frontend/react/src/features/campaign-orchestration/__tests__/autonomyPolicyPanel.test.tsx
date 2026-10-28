/**
 * ADR 0942 P5 — the review-policy panel.
 *
 *   - it renders the SERVER's effective rules (outcome chips, approvers, the
 *     escalation thresholds), never a client-side derivation;
 *   - choosing a level saves `{preset}` with the loaded etag;
 *   - customizing sends the FULL rule set, one rule per (class, stage), with the
 *     edited outcome, the edited threshold and the chosen approver roles;
 *   - a refused loosen names the steps the server said it would loosen;
 *   - the campaign page renders nothing while the feature is off; the client modal says so;
 *   - "Use the client's default" sends DELETE with the etag.
 *
 * What turns it red: re-deriving the grid from a local table (the server-only
 * `x.custom` row vanishes), dropping the etag, sending only changed rows, losing
 * stages, ignoring the threshold edit, swallowing the server's loosened list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ActionRule, EffectiveRule, PolicyView } from '../autonomy/autonomyClient.js';

const h = vi.hoisted(() => ({ getAutonomy: vi.fn(), saveAutonomy: vi.fn(), clearCampaignAutonomy: vi.fn() }));
vi.mock('../autonomy/autonomyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAutonomy: h.getAutonomy, saveAutonomy: h.saveAutonomy, clearCampaignAutonomy: h.clearCampaignAutonomy,
}));

const { AutonomyDisabledError, LoosenRefusedError } = await import('../autonomy/autonomyClient.js');
const { default: AutonomyPolicyPanel } = await import('../autonomy/AutonomyPolicyPanel.js');

const approve = { outcome: 'approve' as const, approver: { roleRefs: ['owner', 'admin'], requiredApprovals: 1 as const, delegation: 'allowed' as const } };
const eff = (actionClass: string, rule: Omit<ActionRule, 'actionClass'>, stage?: 'internal' | 'compliance' | 'client'): EffectiveRule => ({
  actionClass, ...(stage ? { stage } : {}), rule: { actionClass, ...rule }, from: 'preset',
});

function view(over: Partial<PolicyView> = {}): PolicyView {
  return {
    source: 'campaign', dangling: false, etag: 'etag-1',
    policy: { policyId: 'preset:guarded', version: 1, name: 'Guarded', rules: [], hash: 'h' },
    actionClasses: ['creative.generate', 'ads.budget', 'creative.review', 'x.custom'],
    effective: [
      eff('creative.generate', { default: { outcome: 'auto' } }),
      eff('ads.budget', { default: { outcome: 'auto' }, escalations: [{ when: [{ fact: 'spendMinor', op: '>=', value: 50000 }], then: approve }] }),
      eff('creative.review', { default: approve }, 'internal'),
      eff('creative.review', { default: approve }, 'client'),
      eff('x.custom', { default: { outcome: 'blocked', reason: 'nope' } }),
    ],
    presets: [{ id: 'review-everything@1', name: 'Review everything' }, { id: 'guarded@1', name: 'Guarded' }, { id: 'autopilot@1', name: 'Autopilot' }],
    ...over,
  };
}

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(cleanup);

describe('AutonomyPolicyPanel', () => {
  it('drops the previous client\'s draft and etag before a new client can be edited', async () => {
    let resolveNext!: (value: PolicyView) => void;
    h.getAutonomy.mockResolvedValueOnce(view()).mockImplementationOnce(() => new Promise<PolicyView>(resolve => { resolveNext = resolve; }));
    const nextView = view({ etag: 'client-b-etag', effective: [eff('creative.generate', { default: { outcome: 'auto' } })] });
    h.saveAutonomy.mockResolvedValue(nextView);
    const { rerender } = render(<AutonomyPolicyPanel scope={{ kind: 'client', orgId: 'client-a' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize steps' }));
    fireEvent.change(screen.getByLabelText('What happens: Generate creative'), { target: { value: 'blocked' } });
    rerender(<AutonomyPolicyPanel scope={{ kind: 'client', orgId: 'client-b' }} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
    await act(async () => { resolveNext(nextView); });
    fireEvent.click(await screen.findByRole('button', { name: 'Customize steps' }));
    fireEvent.change(screen.getByLabelText('What happens: Generate creative'), { target: { value: 'notify-after' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(h.saveAutonomy).toHaveBeenCalledTimes(1));
    const [scope, body, etag] = h.saveAutonomy.mock.calls[0]!;
    expect(scope).toEqual({ kind: 'client', orgId: 'client-b' });
    expect(etag).toBe('client-b-etag');
    expect(body.rules).toEqual([{ actionClass: 'creative.generate', default: { outcome: 'notify-after', notify: { roleRefs: ['owner', 'admin'], channels: ['inbox'], digest: 'immediate' } } }]);
  });

  it('ignores a late policy load from the client that was closed', async () => {
    let resolveOld!: (value: PolicyView) => void;
    h.getAutonomy.mockImplementationOnce(() => new Promise<PolicyView>(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(view({ policy: { policyId: 'preset:autopilot', version: 1, name: 'Autopilot', rules: [], hash: 'b' } }));
    const { rerender } = render(<AutonomyPolicyPanel scope={{ kind: 'client', orgId: 'client-a' }} />);
    rerender(<AutonomyPolicyPanel scope={{ kind: 'client', orgId: 'client-b' }} />);
    await screen.findByRole('table');
    await act(async () => { resolveOld(view()); });
    expect((screen.getByRole('radio', { name: /Autopilot/ }) as HTMLInputElement).checked).toBe(true);
  });
  it('renders the server\'s effective rules, including a class only the server knows', async () => {
    h.getAutonomy.mockResolvedValue(view());
    render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    const table = await screen.findByRole('table');
    const budget = within(table).getByRole('row', { name: /Change an ad budget/ });
    expect(within(budget).getByText('Runs on its own')).toBeTruthy();
    expect(within(budget).getByText(/Spend \(cents\) ≥ 50,000/)).toBeTruthy();
    expect(within(table).getByRole('row', { name: /Review creative · client review/ })).toBeTruthy();
    // A class the SPA has no group for still renders (server is the vocabulary).
    const other = within(table).getByRole('row', { name: /x\.custom/ });
    expect(within(other).getByText('Blocked')).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Guarded/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('choosing a level saves the preset with the loaded etag, only once applied', async () => {
    h.getAutonomy.mockResolvedValue(view());
    h.saveAutonomy.mockResolvedValue(view({ policy: { policyId: 'preset:review-everything', version: 1, name: 'Review everything', rules: [], hash: 'h2' }, etag: 'etag-2' }));
    render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Review everything/ }));
    // Picking (or arrowing onto) a level saves nothing until it is applied.
    expect(h.saveAutonomy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply this level' }));
    await waitFor(() => expect(h.saveAutonomy).toHaveBeenCalledWith({ kind: 'campaign', campaignId: 'c1' }, { preset: 'review-everything@1' }, 'etag-1'));
    await waitFor(() => expect((screen.getByRole('radio', { name: /Review everything/ }) as HTMLInputElement).checked).toBe(true));
  });

  it('customizing sends every rule, with the edited outcome, threshold and approver roles', async () => {
    h.getAutonomy.mockResolvedValue(view());
    h.saveAutonomy.mockResolvedValue(view());
    render(<AutonomyPolicyPanel scope={{ kind: 'client', orgId: 'o1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize steps' }));
    fireEvent.change(screen.getByLabelText('What happens: Generate creative'), { target: { value: 'notify-after' } });
    fireEvent.change(screen.getByLabelText('Threshold for Change an ad budget, Spend (cents)'), { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Editors' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(h.saveAutonomy).toHaveBeenCalledTimes(1));
    const [scope, body, etag] = h.saveAutonomy.mock.calls[0]!;
    expect(scope).toEqual({ kind: 'client', orgId: 'o1' });
    expect(etag).toBe('etag-1');
    const roles = ['owner', 'admin', 'editor'];
    expect(body).toEqual({
      name: 'Custom', basePreset: 'guarded@1',
      rules: [
        { actionClass: 'creative.generate', default: { outcome: 'notify-after', notify: { roleRefs: roles, channels: ['inbox'], digest: 'immediate' } } },
        { actionClass: 'ads.budget', default: { outcome: 'auto' }, escalations: [{ when: [{ fact: 'spendMinor', op: '>=', value: 20000 }], then: { ...approve, approver: { ...approve.approver, roleRefs: roles } } }] },
        { actionClass: 'creative.review', stage: 'internal', default: { ...approve, approver: { ...approve.approver, roleRefs: roles } } },
        { actionClass: 'creative.review', stage: 'client', default: { ...approve, approver: { ...approve.approver, roleRefs: roles } } },
        { actionClass: 'x.custom', default: { outcome: 'blocked', reason: 'nope' } },
      ],
    });
  });

  it('without a role change, each row keeps its own approvers', async () => {
    const ownerOnly = { outcome: 'approve' as const, approver: { roleRefs: ['owner'], requiredApprovals: 2 as const, delegation: 'none' as const } };
    const v = view();
    // The FIRST approval names owner+admin (what the role checkboxes start from); the
    // staged review row names owner only and must keep it.
    v.effective = [eff('ads.budget', { default: approve }), eff('creative.generate', { default: { outcome: 'auto' } }), eff('creative.review', { default: ownerOnly }, 'client')];
    h.getAutonomy.mockResolvedValue(v);
    h.saveAutonomy.mockResolvedValue(v);
    render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize steps' }));
    fireEvent.change(screen.getByLabelText('What happens: Generate creative'), { target: { value: 'blocked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(h.saveAutonomy).toHaveBeenCalledTimes(1));
    const rules = (h.saveAutonomy.mock.calls[0]![1] as { rules: ActionRule[] }).rules;
    expect(rules[2]).toEqual({ actionClass: 'creative.review', stage: 'client', default: ownerOnly });
  });

  it('a refused loosen names the steps the server said it would loosen', async () => {
    h.getAutonomy.mockResolvedValue(view());
    h.saveAutonomy.mockRejectedValue(new LoosenRefusedError('forbidden', ['ads.budget', 'creative.review:client']));
    render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Autopilot/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply this level' }));
    const alert = await screen.findByText(/Only an admin of this client/);
    expect(alert.textContent).toContain('It would loosen: Change an ad budget, Review creative.');
  });

  it('feature off: the campaign page renders nothing; the client modal says it is off', async () => {
    h.getAutonomy.mockRejectedValue(new AutonomyDisabledError('not enabled'));
    const { container } = render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    await waitFor(() => expect(h.getAutonomy).toHaveBeenCalled());
    await waitFor(() => expect(container.innerHTML).toBe(''));
    cleanup();
    render(<AutonomyPolicyPanel scope={{ kind: 'client', orgId: 'o1' }} bare />);
    expect(await screen.findByText('Review policies are not turned on for this workspace.')).toBeTruthy();
  });

  it('a failed read is said, never shown as an empty policy', async () => {
    h.getAutonomy.mockRejectedValue(new Error('boom'));
    render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    expect(await screen.findByText('The review policy could not be loaded.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('"Use the client\'s default" drops the override with the etag', async () => {
    h.getAutonomy.mockResolvedValue(view());
    h.clearCampaignAutonomy.mockResolvedValue(view({ source: 'client' }));
    render(<AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: 'c1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: "Use the client's default" }));
    await waitFor(() => expect(h.clearCampaignAutonomy).toHaveBeenCalledWith('c1', 'etag-1'));
    expect(await screen.findByText("The client's default")).toBeTruthy();
  });
});
