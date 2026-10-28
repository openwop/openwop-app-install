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
 *
 * /grade-tests w52 — witnessed by sabotage of `CreativeBriefsPage.tsx`:
 * dropping `if (dirty) await saveFields()` (CRB-G1 order), sending the wrong
 * target status (the transition args are asserted exactly), demoting the error
 * Notice to `warning` (case 1 now reads the NOTICE, not any alert — the title
 * Field renders its own `role="alert"`, which used to satisfy it), and
 * filtering errors on `=== 'error'` (unknown severity). The file is fetch-free:
 * `RendersSection` reads templates + renders on mount, so both are mocked
 * (ADR 0661; it was on the live-fetch allowlist only because they were not).
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
    // ADR 0945 Q1 — the briefs page reads the client's edit-mode opt-in when product-grounded creative is on.
    getGroundingSettings: vi.fn(async () => ({ editModeEnabled: false })),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBriefs: (...a: unknown[]) => listBriefs(...a),
    getBrief: (...a: unknown[]) => getBrief(...a),
    updateBrief: (...a: unknown[]) => { calls.push('update'); return updateBrief(...a); },
    transitionBrief: (...a: unknown[]) => { calls.push('transition'); return transitionBrief(...a); },
    listVersions: vi.fn(async () => []),
    deleteBrief: vi.fn(async () => {}),
    // RendersSection's mount reads — unmocked, they were live fetches.
    listRenderTemplates: vi.fn(async () => []),
    listRenders: vi.fn(async () => []),
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
  const base: CreativeBrief = {
    briefId: 'cb-1', orgId: 'org-1', title: 'Spring hero', assetType: 'still',
    sceneDescription: 'A field at dawn', directions: [], moodBoard: [],
    status: 'review', version: 3, updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return { ...base, ...over };
}

/** The issue panel's own Notice (by its title), not any `role` region — the
 *  Fields render their own `role="alert"` errors, which a bare role query
 *  would accept in the Notice's place. */
function noticeTitled(role: 'alert' | 'status', title: RegExp): HTMLElement {
  const hit = screen.getAllByRole(role).find((n) => title.test(n.textContent ?? ''));
  if (!hit) throw new Error(`no ${role} notice titled ${String(title)}`);
  return hit;
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
    expect(transitionBrief).toHaveBeenCalledWith('org-1', 'cb-1', 'approved');
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it('CRB-G1: an edited brief SAVES before it approves — in that order', async () => {
    await openDetail(brief());
    fireEvent.change(screen.getByDisplayValue('A field at dawn'), { target: { value: 'A field at dusk' } });

    // The action renames itself, so the write is disclosed, not surprising.
    const approve = await screen.findByRole('button', { name: /save & approve/i });
    fireEvent.click(approve);

    await waitFor(() => expect(transitionBrief).toHaveBeenCalled());
    expect(transitionBrief).toHaveBeenCalledWith('org-1', 'cb-1', 'approved');
    // Order matters: approving first would approve the stored version, and the
    // later save would then DEMOTE the brief back to draft and purge its links.
    expect(calls).toEqual(['update', 'transition']);
    expect(updateBrief).toHaveBeenCalledWith('org-1', 'cb-1', expect.objectContaining({ sceneDescription: 'A field at dusk' }));
  });

  it('CRB-G1: send-to-review discloses the save too — and saves before it transitions', async () => {
    await openDetail(brief({ status: 'draft' }));
    fireEvent.change(screen.getByDisplayValue('A field at dawn'), { target: { value: 'Changed' } });
    fireEvent.click(await screen.findByRole('button', { name: /save & send to review/i }));
    await waitFor(() => expect(transitionBrief).toHaveBeenCalled());
    expect(calls).toEqual(['update', 'transition']);
    expect(transitionBrief).toHaveBeenCalledWith('org-1', 'cb-1', 'review');
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
    // An `error` Notice announces assertively; the warning stays a polite status
    // — and neither absorbs the other's issue.
    const errors = noticeTitled('alert', /1 issue\(s\) must be fixed/);
    expect(errors.textContent).toContain('A title is required');
    expect(errors.textContent).not.toContain('Messaging intent helps');
    const warnings = noticeTitled('status', /1 suggestion\(s\)/);
    expect(warnings.textContent).toContain('Messaging intent helps');
    expect(warnings.textContent).not.toContain('A title is required');
  });

  it('CRB-G2: each issue names its field', async () => {
    await openDetail(brief({
      issues: [{ field: 'sceneDescription', severity: 'error', message: 'A scene description is required' }],
    }));
    const alert = noticeTitled('alert', /must be fixed/);
    expect(alert.textContent).toContain('A scene description is required');
    expect(within(alert).getByText('Scene')).toBeTruthy();
  });

  it('CRB-G2: an issue with an UNKNOWN severity is treated as an error, not downgraded', async () => {
    // A severity outside the client's union is a WIRE value (a newer server):
    // it arrives through JSON, so it is built through JSON, not a cast.
    // `composition` has no field-error control, so the Notice is its only carrier.
    const wire: CreativeBrief = JSON.parse(JSON.stringify({
      ...brief(), issues: [{ field: 'composition', severity: 'critical', message: 'A future rule fired' }],
    }));
    await openDetail(wire);
    // A rule we don't recognise must not be quietly demoted to a suggestion.
    expect(noticeTitled('alert', /must be fixed/).textContent).toContain('A future rule fired');
    expect(screen.queryByText(/suggestion\(s\)/)).toBeNull();
  });

  it('CRB-G2: no issues renders neither notice', async () => {
    await openDetail(brief({ issues: [] }));
    expect(screen.queryByText(/must be fixed/i)).toBeNull();
    expect(screen.queryByText(/suggestion/i)).toBeNull();
  });
});
