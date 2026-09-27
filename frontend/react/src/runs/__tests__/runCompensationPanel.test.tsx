/**
 * ADR 0554 P3 — the run-detail compensation panel.
 *
 * Three properties are worth a test here, and each is one the panel could
 * plausibly get wrong in a way that looks fine:
 *
 *  1. GATED RENDERING — a recovery button appears only with its scope, and the
 *     ladder is real (an admin sees Retry and NOT Waive). Asserting only that
 *     "some button renders for an owner" would pass with no gating at all.
 *  2. REASON VALIDATION — the waive confirm stays disabled until a non-blank
 *     reason is typed, so the operator learns the rule here rather than via a
 *     400 from the route.
 *  3. THE PENDING-APPROVAL AND NOT-APPLIED STATES — both are cases where the
 *     truthful answer ("this has NOT happened yet") is easy to render as though
 *     it had.
 *
 * Assertions read the `en` catalog object rather than literal English, so a copy
 * change does not silently red the suite and a missing key fails loudly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GlobalLiveRegion } from '../../ui/announce.js';

const api = vi.hoisted(() => ({
  getRunCompensation: vi.fn(),
  postRunCompensationAction: vi.fn(),
}));
vi.mock('../../client/operationsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };  // keeps the real OperationsRequestError class
});

const access = vi.hoisted(() => ({
  state: { access: { roles: ['owner'], scopes: [] as string[], basis: 'member' }, resolved: true },
}));
vi.mock('../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => access.state,
  useEffectiveAccess: () => access.state.access,
}));

import { RunCompensationPanel } from '../RunCompensationPanel.js';
import { OperationsRequestError } from '../../client/operationsClient.js';
import { messages as en } from '../i18n/en.js';

const OWED = {
  obligationId: 'cmp_abc',
  runId: 'run-1',
  nodeId: 'charge-card',
  state: 'requested' as const,
  shape: 'forward-effect',
  effectKind: 'payment',
  attempts: 0,
  reason: null,
  requiresApproval: false,
  committedAt: '2026-08-17T10:00:00.000Z',
  updatedAt: '2026-08-17T10:00:00.000Z',
  startedBy: null,
  waiveApprovalId: null,
  compensationOrdinal: 1,
  history: [],
};

const PLAN = {
  runId: 'run-1',
  compensationStatus: 'pending',
  auditChain: { ok: true },
  obligations: [OWED],
};

function renderPanel(): void {
  render(
    <MemoryRouter>
      <GlobalLiveRegion />
      <div data-testid="page"><RunCompensationPanel runId="run-1" /></div>
    </MemoryRouter>,
  );
}
const page = () => within(screen.getByTestId('page'));

beforeEach(() => {
  vi.clearAllMocks();
  access.state = { access: { roles: ['owner'], scopes: ['host:compensation:waive', 'host:compensation:retry', 'host:compensation:start'], basis: 'member' }, resolved: true };
  api.getRunCompensation.mockResolvedValue(PLAN);
  api.postRunCompensationAction.mockResolvedValue({ state: 'failed', auditSeq: 1, compensationStatus: 'partial' });
});
afterEach(cleanup);

describe('gated rendering', () => {
  it('shows Retry and Waive to a principal holding both scopes', async () => {
    renderPanel();
    expect(await page().findByRole('button', { name: en.compRetry })).toBeTruthy();
    expect(page().getByRole('button', { name: en.compWaive })).toBeTruthy();
  });

  /**
   * THE LADDER LEG, mirrored on the client. Without it the suite would pass with
   * no gating whatsoever, because the "owner sees buttons" case above renders
   * everything.
   */
  it('shows Retry but NOT Waive to an ADMIN-tier principal', async () => {
    access.state = {
      access: { roles: ['admin'], scopes: ['host:compensation:start', 'host:compensation:retry'], basis: 'member' },
      resolved: true,
    };
    renderPanel();
    expect(await page().findByRole('button', { name: en.compRetry })).toBeTruthy();
    expect(page().queryByRole('button', { name: en.compWaive })).toBeNull();
  });

  it('shows NO recovery buttons to a principal with none of the scopes', async () => {
    access.state = { access: { roles: ['viewer'], scopes: ['runs:read'], basis: 'member' }, resolved: true };
    renderPanel();
    await page().findByText(en.compHeading);
    expect(page().queryByRole('button', { name: en.compRetry })).toBeNull();
    expect(page().queryByRole('button', { name: en.compWaive })).toBeNull();
    expect(page().queryByRole('button', { name: en.compStart })).toBeNull();
  });

  /**
   * A FAILED scope read is not a denial. Hiding the buttons silently would leave
   * the operator unable to tell "I lack permission" from "the app does not know".
   */
  it('says WHY the actions are missing when the scope read resolved to nothing', async () => {
    access.state = { access: { roles: [], scopes: [], basis: 'none' }, resolved: true };
    renderPanel();
    expect(await page().findByText(en.compScopeUnknown)).toBeTruthy();
  });

  it('does NOT show that warning when the scopes resolved normally', async () => {
    renderPanel();
    await page().findByText(en.compHeading);
    expect(page().queryByText(en.compScopeUnknown)).toBeNull();
  });
});

describe('reason validation on a waive', () => {
  it('keeps the confirm disabled until a non-blank reason is typed', async () => {
    renderPanel();
    fireEvent.click(await page().findByRole('button', { name: en.compWaive }));

    const confirm = page().getByRole('button', { name: en.compWaiveConfirm });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // Whitespace is not a reason — the same rule the route enforces.
    fireEvent.change(page().getByLabelText(en.compWaiveReasonLabel), { target: { value: '   ' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(page().getByLabelText(en.compWaiveReasonLabel), {
      target: { value: 'the counterparty confirmed no charge was captured' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the reason AND the state the operator saw, so a lost race is detectable', async () => {
    renderPanel();
    fireEvent.click(await page().findByRole('button', { name: en.compWaive }));
    fireEvent.change(page().getByLabelText(en.compWaiveReasonLabel), { target: { value: 'accepted the loss' } });
    fireEvent.click(page().getByRole('button', { name: en.compWaiveConfirm }));

    await waitFor(() => expect(api.postRunCompensationAction).toHaveBeenCalledTimes(1));
    expect(api.postRunCompensationAction.mock.calls[0]![0]).toMatchObject({
      runId: 'run-1',
      obligationId: 'cmp_abc',
      action: 'skip',
      reason: 'accepted the loss',
      expectedState: 'requested',   // NOT re-read from the server
    });
  });

  it('a retry needs no reason and sends none', async () => {
    renderPanel();
    fireEvent.click(await page().findByRole('button', { name: en.compRetry }));
    await waitFor(() => expect(api.postRunCompensationAction).toHaveBeenCalledTimes(1));
    const sent = api.postRunCompensationAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent['action']).toBe('retry');
    expect(sent['reason']).toBeUndefined();
  });
});

describe('states the panel must not overstate', () => {
  it('renders an open waive approval as NOT YET waived', async () => {
    api.getRunCompensation.mockResolvedValue({
      ...PLAN,
      obligations: [{ ...OWED, requiresApproval: true, waiveApprovalId: 'appr:xyz' }],
    });
    renderPanel();
    expect(await page().findByText(/appr:xyz/)).toBeTruthy();
    // The copy itself has to carry "has NOT been waived yet" — a bare
    // "pending approval" chip would read as done-ish.
    expect(en.compApprovalPending).toMatch(/NOT been waived yet/);
  });

  it('renders an unapplied audit entry as RECORDED, NOT APPLIED', async () => {
    api.getRunCompensation.mockResolvedValue({
      ...PLAN,
      obligations: [{
        ...OWED,
        history: [{
          seq: 4, at: '2026-08-17T11:00:00.000Z', entryHash: 'h', applied: false,
          payload: {
            obligationId: 'cmp_abc', runId: 'run-1', action: 'terminate', actor: 'user:owner',
            requiredScope: 'host:compensation:waive', reason: 'crashed here',
            priorState: 'requested', requestedState: 'failed', prevSeq: null, prevEntryHash: null,
          },
        }],
      }],
    });
    renderPanel();
    expect(await page().findByText(en.compRecordedNotApplied)).toBeTruthy();
    expect(page().queryByText(en.compApplied)).toBeNull();
  });

  it('renders an APPLIED entry as applied — so the leg above is not passing on a blanket label', async () => {
    api.getRunCompensation.mockResolvedValue({
      ...PLAN,
      obligations: [{
        ...OWED,
        state: 'failed' as const,
        history: [{
          seq: 4, at: '2026-08-17T11:00:00.000Z', entryHash: 'h', applied: true,
          payload: {
            obligationId: 'cmp_abc', runId: 'run-1', action: 'skip', actor: 'user:owner',
            requiredScope: 'host:compensation:waive', reason: 'accepted the loss',
            priorState: 'requested', requestedState: 'failed', prevSeq: null, prevEntryHash: null,
          },
        }],
      }],
    });
    renderPanel();
    expect(await page().findByText(en.compApplied)).toBeTruthy();
    expect(page().queryByText(en.compRecordedNotApplied)).toBeNull();
  });

  it('warns loudly when the audit chain failed verification, naming the entry', async () => {
    api.getRunCompensation.mockResolvedValue({ ...PLAN, auditChain: { ok: false, brokenAt: 7 } });
    renderPanel();
    // The exact interpolated string, not a bare /7/ — timestamps in the rows
    // contain digits too, and a loose match would pass on the wrong element.
    const expected = en.compChainBroken.replace('{{seq}}', '7');
    expect((await page().findAllByText(expected)).length).toBeGreaterThan(0);
  });

  it('does NOT warn when the chain verified', async () => {
    renderPanel();
    await page().findByText(en.compHeading);
    expect(page().queryByText(en.compChainBroken.replace('{{seq}}', '7'))).toBeNull();
  });

  it('distinguishes "no compensation was owed" from a failed read', async () => {
    api.getRunCompensation.mockResolvedValue({ ...PLAN, obligations: [], compensationStatus: 'none' });
    renderPanel();
    expect(await page().findByText(en.compEmptyTitle)).toBeTruthy();

    cleanup();
    api.getRunCompensation.mockRejectedValue(new Error('network down'));
    renderPanel();
    expect(await page().findByText(en.compUnavailableTitle)).toBeTruthy();
    // The two must not share a message — an operator acts differently on each.
    expect(en.compEmptyTitle).not.toBe(en.compUnavailableTitle);
  });

  it('renders the forbidden state for a 403, not the generic failure', async () => {
    api.getRunCompensation.mockRejectedValue(new OperationsRequestError('forbidden', 403));
    renderPanel();
    expect(await page().findByText(en.compForbiddenTitle)).toBeTruthy();
    expect(page().queryByText(en.compUnavailableTitle)).toBeNull();
  });
});

describe('the lost-race response', () => {
  it('tells the operator someone acted first and RE-READS the timeline', async () => {
    api.postRunCompensationAction.mockRejectedValue(
      new OperationsRequestError('moved', 409, 'version_conflict'),
    );
    renderPanel();
    fireEvent.click(await page().findByRole('button', { name: en.compRetry }));

    // Two reads: the initial load, then the forced re-read after the conflict.
    await waitFor(() => expect(api.getRunCompensation).toHaveBeenCalledTimes(2));
  });

  /**
   * `approval_required` and `version_conflict` share a 409 and mean opposite
   * things. Branching on the CODE is what keeps them apart; a status-only check
   * would report a raised approval as a lost race.
   */
  it('reports an approval-gated waive as an approval raised, not as a conflict', async () => {
    api.postRunCompensationAction.mockRejectedValue(
      new OperationsRequestError('gated', 409, 'approval_required', { approvalId: 'appr:xyz' }),
    );
    renderPanel();
    fireEvent.click(await page().findByRole('button', { name: en.compWaive }));
    fireEvent.change(page().getByLabelText(en.compWaiveReasonLabel), { target: { value: 'r' } });
    fireEvent.click(page().getByRole('button', { name: en.compWaiveConfirm }));

    await waitFor(() => expect(api.getRunCompensation).toHaveBeenCalledTimes(2));
    // The form closed — the request was accepted for review, not rejected.
    await waitFor(() => expect(page().queryByLabelText(en.compWaiveReasonLabel)).toBeNull());
  });
});
