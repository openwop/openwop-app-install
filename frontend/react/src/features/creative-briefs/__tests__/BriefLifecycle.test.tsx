/**
 * UX_UPGRADE-creative-briefs — CRB-G1 / CRB-G2.
 *
 *  - CRB-G1: every lifecycle action targeted the SERVER's brief while the form
 *    held unsaved edits, so Approve approved a version the approver was not
 *    looking at — and approval is what unlocks sharing. The service also demotes
 *    an approved brief back to `draft` on the next content edit (purging its
 *    share links), so edit → approve → save silently un-approved.
 *  - CRB-G2: the validator grades each issue `error` | `warning` and names its
 *    field. Both were erased into one joined WARNING strip, so a blocker read
 *    exactly like a suggestion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CreativeBrief } from '../creativeBriefsClient.js';

const getBrief = vi.fn();
const listBriefs = vi.fn();
const updateBrief = vi.fn();
const transitionBrief = vi.fn();
const calls: string[] = [];

vi.mock('../creativeBriefsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBriefs: (...a: unknown[]) => listBriefs(...a),
    getBrief: (...a: unknown[]) => getBrief(...a),
    updateBrief: (...a: unknown[]) => { calls.push('update'); return updateBrief(...a); },
    transitionBrief: (...a: unknown[]) => { calls.push('transition'); return transitionBrief(...a); },
    listVersions: vi.fn(async () => []),
    deleteBrief: vi.fn(async () => {}),
  };
});
vi.mock('../../media/mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAssets: vi.fn(async () => []),
  absoluteServeUrl: (s: string) => s,
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { CreativeBriefsPage } from '../CreativeBriefsPage.js';

function brief(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    briefId: 'cb-1', orgId: 'org-1', title: 'Spring hero', assetType: 'still',
    sceneDescription: 'A field at dawn', directions: [], moodBoard: [],
    status: 'review', version: 3, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as CreativeBrief;
}

async function openDetail(b: CreativeBrief): Promise<void> {
  listBriefs.mockResolvedValue([b]);
  getBrief.mockResolvedValue(b);
  // ADR 0522 — a brief opens at its own PATH now, not `?brief=`; the component
  // reads `:briefId` via useParams, so the route has to be declared here.
  render(
    <MemoryRouter initialEntries={[`/creative-briefs/${b.briefId}`]}>
      <Routes>
        <Route path="/creative-briefs" element={<CreativeBriefsPage />} />
        <Route path="/creative-briefs/:briefId" element={<CreativeBriefsPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await screen.findByDisplayValue('Spring hero');
}

beforeEach(() => {
  calls.length = 0;
  listBriefs.mockReset(); getBrief.mockReset(); updateBrief.mockReset(); transitionBrief.mockReset();
  updateBrief.mockResolvedValue(brief());
  transitionBrief.mockResolvedValue(brief({ status: 'approved' }));
});
afterEach(cleanup);

describe('lifecycle acts on the brief on screen', () => {
  it('CRB-G1: a clean brief approves WITHOUT writing first', async () => {
    await openDetail(brief());
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(transitionBrief).toHaveBeenCalled());
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it('CRB-G1: an edited brief SAVES before it approves — in that order', async () => {
    await openDetail(brief());
    fireEvent.change(screen.getByDisplayValue('A field at dawn'), { target: { value: 'A field at dusk' } });

    // The action renames itself, so the write is disclosed, not surprising.
    const approve = await screen.findByRole('button', { name: /save & approve/i });
    fireEvent.click(approve);

    await waitFor(() => expect(transitionBrief).toHaveBeenCalled());
    // Order matters: approving first would approve the stored version, and the
    // later save would then DEMOTE the brief back to draft and purge its links.
    expect(calls).toEqual(['update', 'transition']);
    const [, , payload] = updateBrief.mock.calls[0] as [string, string, { sceneDescription: string }];
    expect(payload.sceneDescription).toBe('A field at dusk');
  });

  it('CRB-G1: send-to-review discloses the save too', async () => {
    await openDetail(brief({ status: 'draft' }));
    fireEvent.change(screen.getByDisplayValue('A field at dawn'), { target: { value: 'Changed' } });
    expect(await screen.findByRole('button', { name: /save & send to review/i })).toBeTruthy();
  });
});

describe('issue severity survives to the screen', () => {
  it('CRB-G2: errors and warnings render as separate, differently-weighted notices', async () => {
    await openDetail(brief({
      issues: [
        { field: 'title', severity: 'error', message: 'A title is required' },
        { field: 'messagingIntent', severity: 'warning', message: 'Messaging intent helps the designer land the point' },
      ],
    }));
    const alerts = screen.getAllByRole('alert');
    // An `error` Notice announces assertively; the warning stays a polite status.
    expect(alerts.some((n) => (n.textContent ?? '').includes('A title is required'))).toBe(true);
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((n) => (n.textContent ?? '').includes('Messaging intent helps'))).toBe(true);
  });

  it('CRB-G2: each issue names its field', async () => {
    await openDetail(brief({
      issues: [{ field: 'sceneDescription', severity: 'error', message: 'A scene description is required' }],
    }));
    const alert = screen.getAllByRole('alert').find((n) => (n.textContent ?? '').includes('scene description'))!;
    expect(within(alert).getByText('Scene')).toBeTruthy();
  });

  it('CRB-G2: an issue with an UNKNOWN severity is treated as an error, not downgraded', async () => {
    await openDetail(brief({
      issues: [{ field: 'title', severity: 'critical' as 'error', message: 'A future rule fired' }],
    }));
    // A rule we don't recognise must not be quietly demoted to a suggestion.
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((n) => (n.textContent ?? '').includes('A future rule fired'))).toBe(true);
  });

  it('CRB-G2: no issues renders neither notice', async () => {
    await openDetail(brief({ issues: [] }));
    expect(screen.queryByText(/must be fixed/i)).toBeNull();
    expect(screen.queryByText(/suggestion/i)).toBeNull();
  });
});
