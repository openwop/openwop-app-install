/**
 * Feature 26/71 PR-B (ADR 0598) — the UX half of the `/grade-ux` pass.
 *
 * Everything here is a HUMAN-END guarantee the three prior rounds did not cover:
 * that a save says it worked, that a failure stops being claimed once it is over,
 * and that leaving a tab does not silently destroy a draft. Each `describe` names
 * its `SPU-` row so the tracker and the assertion cannot drift apart.
 *
 * Sabotage-witnessed (grade-tests w19, probes w19g5-r4-*, 45 probes): every case
 * below went red under a single-edit break of the behavior it names (dropped
 * `setError(null)`, toasts, `announce`, the leave guard and each dirty source,
 * the focus effect and its tick, the combined-disclosure branch, the KR/objective
 * group labels, the SPU-7 FeatureDisabled split, …).
 *
 * Cut in w19 as covered elsewhere (both cases went red under the same probe):
 *  - SPU-9 "ONE blank title reads as a singular sentence" → strategyR3.test.tsx
 *    "a blanked objective title blocks the save — the API is never called".
 *  - ADR 0597 "says the edit withdrew…" / "the OVERVIEW editor reports it too" →
 *    the §Correction 4 "…withdrawal disclosure IS the confirmation" cases below,
 *    which make the same assertion and also pin the missing second toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type * as Client from '../strategyClient.js';
import type { Strategy, StrategyContextEntry } from '../strategyClient.js';

// Typed against the real client, so a fixture that does not match the wire shape
// fails `tsc` instead of passing as a partial object.
const getStrategy = vi.fn<typeof Client.getStrategy>();
const listStrategies = vi.fn<typeof Client.listStrategies>();
const listProjects = vi.fn<typeof Client.listProjects>();
const updateStrategy = vi.fn<typeof Client.updateStrategy>();
const replaceLinks = vi.fn<typeof Client.replaceLinks>();
const importObjectives = vi.fn<typeof Client.importObjectives>();
const getStrategyTimeline = vi.fn<typeof Client.getStrategyTimeline>();
const getStrategyDetailContext = vi.fn<typeof Client.getStrategyDetailContext>();
const getStrategyContext = vi.fn<typeof Client.getStrategyContext>();
const toastSuccess = vi.fn<(m: string) => void>();

vi.mock('../strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategy: (...a: Parameters<typeof Client.getStrategy>) => getStrategy(...a),
  listStrategies: (...a: Parameters<typeof Client.listStrategies>) => listStrategies(...a),
  listProjects: () => listProjects(),
  updateStrategy: (...a: Parameters<typeof Client.updateStrategy>) => updateStrategy(...a),
  getStrategyDetailContext: (...a: Parameters<typeof Client.getStrategyDetailContext>) => getStrategyDetailContext(...a),
  getStrategyContext: (...a: Parameters<typeof Client.getStrategyContext>) => getStrategyContext(...a),
  listStrategyCheckIns: vi.fn(async () => []),
  getStrategyTimeline: (...a: Parameters<typeof Client.getStrategyTimeline>) => getStrategyTimeline(...a),
  replaceLinks: (...a: Parameters<typeof Client.replaceLinks>) => replaceLinks(...a),
  importObjectives: (...a: Parameters<typeof Client.importObjectives>) => importObjectives(...a),
}));
// ADR 0661 — a SECOND shape, distinct from "the factory missed an export": this
// live fetch came from a SHARED cross-feature module (`orgs/orgMembers.ts`) that
// the test never considered at all, reached through a component this page renders.
// Nothing here asserts on members.
vi.mock('../../../orgs/orgMembers.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadOrgMembers: vi.fn(async () => []),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));
const confirmMock = vi.fn<(o: unknown) => Promise<boolean>>();
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));

import { currentAnnouncements } from '../../../ui/announce.js';
import { StrategyDetailPage } from '../StrategyDetailPage.js';
import { ProjectStrategyChips } from '../StrategyAlignment.js';
import { FeatureDisabledError } from '../strategyClient.js';

const STRATEGY: Strategy = {
  id: 's1', tenantId: 'user:t1', orgId: 'org-1', scope: 'org',
  title: 'Win the mid-market', planningHorizon: 'annual',
  period: { label: '2026' }, status: 'active',
  objectives: [
    { id: 'o1', title: 'Grow pipeline', keyResults: [{ id: 'k1', title: 'MQLs 2x' }] },
    { id: 'o2', title: 'Retain the base', keyResults: [] },
  ],
  initiatives: [], links: [],
  createdBy: 'user:t1', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

/** A PATCH / import response: the full saved strategy plus the flags under test. */
const saved = (flags: Partial<Strategy> = {}): Strategy => ({ ...structuredClone(STRATEGY), ...flags });

const view = async (tab: string): Promise<void> => {
  render(
    <MemoryRouter initialEntries={[`/strategy/s1?tab=${tab}`]}>
      <Routes><Route path="/strategy/:strategyId" element={<StrategyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(getStrategy).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [getStrategy, listStrategies, listProjects, updateStrategy, replaceLinks, importObjectives, getStrategyTimeline, getStrategyDetailContext, getStrategyContext, toastSuccess, confirmMock]) m.mockReset();
  confirmMock.mockResolvedValue(true);
  getStrategy.mockImplementation(async () => structuredClone(STRATEGY));
  listStrategies.mockResolvedValue([]);
  listProjects.mockResolvedValue([]);
  updateStrategy.mockResolvedValue(saved());
  replaceLinks.mockResolvedValue(saved());
  importObjectives.mockResolvedValue({ imported: 2, skipped: [], strategy: saved() });
  getStrategyTimeline.mockResolvedValue([]);
  getStrategyDetailContext.mockResolvedValue(null);
  getStrategyContext.mockResolvedValue([]);
});
afterEach(cleanup);

describe('SPU-3 — a failure stops being claimed once it is over (detail page)', () => {
  it('a successful save clears the error the previous blocked save raised', async () => {
    await view('objectives');
    const title = await screen.findByDisplayValue('Grow pipeline');

    fireEvent.change(title, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/an empty title/i)).toBeTruthy();

    // Fill it back in and save for real.
    fireEvent.change(title, { target: { value: 'Grow pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateStrategy).toHaveBeenCalled());

    // Positive control: the save genuinely went through, so the absent banner
    // cannot pass by the save having been blocked a second time.
    await waitFor(() => expect(screen.queryByText(/an empty title/i)).toBeNull());
  });

  it('the auto-revert disclosure survives its own save, then clears on the next clean one', async () => {
    // The R2 STR2-M5 warning is raised by the save itself, IMMEDIATELY before
    // `onChanged()` — so clearing stale state inside `refresh()` would have
    // destroyed this notice at the moment it was raised. It is cleared by the
    // NEXT save instead, which is what these two arms pin.
    updateStrategy.mockResolvedValueOnce(saved({ autoRevertedToDraft: true, autoRevertedFields: ['objectives'] }));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/returns it to Draft/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateStrategy.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByText(/returns it to Draft/i)).toBeNull());
  });
});

describe('SPU-2 — a save that worked says so', () => {
  it('the objectives save confirms, and the confirmation is ANNOUNCED (not merely rendered)', async () => {
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateStrategy).toHaveBeenCalled());
    // `toast.success` is the assertion subject precisely BECAUSE it announces
    // (`ui/toast.tsx:69` routes every non-error toast through `announce()`), which
    // a bare success <Notice> would not — it would mount with its text already
    // inside and speak nothing.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Objectives saved'));
  });

  it('the alignment save confirms', async () => {
    await view('alignment');
    fireEvent.click(await screen.findByRole('button', { name: /save alignment/i }));
    await waitFor(() => expect(replaceLinks).toHaveBeenCalled());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Alignment saved'));
  });

  it('a FAILED save confirms nothing — the toast is a claim about the outcome', async () => {
    updateStrategy.mockRejectedValue(new Error('save 500'));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText('save 500')).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('an AUTO-REVERTING save raises the disclosure INSTEAD of a plain "saved"', async () => {
    // Two strings in the polite queue would mean the second (less informative)
    // one describes the save; one message per save is the rule.
    updateStrategy.mockResolvedValue(saved({ autoRevertedToDraft: true, autoRevertedFields: ['objectives'] }));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/returns it to Draft/i)).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('SPU-1 — the CSV import result reaches assistive tech', () => {
  const runImport = async (): Promise<void> => {
    await view('objectives');
    const csv = await screen.findByLabelText(/^csv$/i);
    fireEvent.change(csv, { target: { value: 'o,kr,1,x' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(importObjectives).toHaveBeenCalled());
  };

  it('a CLEAN import is spoken — the case that used to be entirely silent', async () => {
    const before = currentAnnouncements().polite;
    await runImport();
    await waitFor(() => expect(currentAnnouncements().polite).not.toBe(before));
    expect(currentAnnouncements().polite).toContain('2 rows imported');
  });

  it('the skip REASONS are spoken, not just the counts', async () => {
    importObjectives.mockResolvedValue({ imported: 1, skipped: [{ line: 4, reason: 'over the row cap' }], strategy: saved() });
    await runImport();
    // The visible <Notice> lists the reasons; before this fix the only announced
    // string was the count summary, so the part the user must act on was silent.
    await waitFor(() => expect(currentAnnouncements().polite).toContain('over the row cap'));
    expect(currentAnnouncements().polite).toContain('Row 4');
  });

  it('the result region does NOT carry a live role — it is mounted with its text', async () => {
    await runImport();
    const node = await screen.findByText(/2 rows imported/);
    // A region that arrives complete announces nothing while an attribute-level
    // test passes either way; this asserts the dead region is GONE, so the
    // imperative announcement above is the single channel (no DS-8 double).
    expect(node.getAttribute('role')).toBeNull();
    expect(node.getAttribute('aria-live')).toBeNull();
  });
});

describe('SPU-4 — leaving a tab does not silently destroy the draft', () => {
  const typeAnObjective = async (): Promise<HTMLElement> => {
    await view('objectives');
    const title = await screen.findByDisplayValue('Grow pipeline');
    fireEvent.change(title, { target: { value: 'Grow pipeline in EMEA' } });
    return title;
  };

  it('CANCELLING the confirm keeps both the tab and the draft', async () => {
    confirmMock.mockResolvedValue(false);
    await typeAnObjective();
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
    // The draft is still on screen AND the tab never moved — a guard that
    // prompted and switched anyway would be worse than no guard.
    expect(screen.getByDisplayValue('Grow pipeline in EMEA')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /objectives/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('CONFIRMING discards and switches — the guard has an exit', async () => {
    confirmMock.mockResolvedValue(true);
    await typeAnObjective();
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    await waitFor(() => expect(screen.getByRole('tab', { name: /initiatives/i }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByDisplayValue('Grow pipeline in EMEA')).toBeNull();
  });

  it('a CLEAN tab switches with no prompt (the over-fire control)', async () => {
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('tab', { name: /initiatives/i }).getAttribute('aria-selected')).toBe('true'));
  });

  it('typing and then UNDOING the edit is clean again — dirty tracks VALUE, not touch', async () => {
    const title = await typeAnObjective();
    fireEvent.change(title, { target: { value: 'Grow pipeline' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('MEASUREMENT config alone counts as dirty — it lives in a separate state atom', async () => {
    // `measureDrafts` is not part of `objectives`, so a dirty check that compared
    // only the objectives tree would report a fully-configured measurement block
    // as clean and discard it silently — the defect wearing a guard. This is the
    // costliest typing on the tab, so it is the case that most needs the assertion.
    confirmMock.mockResolvedValue(false);
    await view('objectives');
    fireEvent.change(await screen.findByLabelText(/^measurement$/i), { target: { value: 'numeric' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
  });

  it('the SAME guard covers "Back to portfolio", the other way off this page', async () => {
    confirmMock.mockResolvedValue(false);
    await typeAnObjective();
    fireEvent.click(screen.getByRole('link', { name: /back to portfolio/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
    expect(screen.getByDisplayValue('Grow pipeline in EMEA')).toBeTruthy();
  });

  it('the ALIGNMENT tab is guarded too — it is not an objectives-only rule', async () => {
    confirmMock.mockResolvedValue(false);
    listProjects.mockResolvedValue([{ id: 'p1', name: 'Atlas', orgId: 'org-1', status: 'active' }]);
    await view('alignment');
    fireEvent.change(await screen.findByLabelText(/link a project/i), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: /add link/i }));
    fireEvent.click(screen.getByRole('tab', { name: /overview/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
  });
});

/**
 * ADR 0598 §Correction 5 — SPU-4's own family, in the lane its enumeration
 * never walked.
 *
 * "ONE rule at ONE composition owner" was the right shape and it was applied to
 * the four TAB EDITORS. The Objectives tab holds THREE draft-bearing components:
 * `ObjectivesEditor`, `ImportObjectivesBlock` (a CSV textarea) and
 * `CheckInsPanel` (a value + note per measured key result). Only the first
 * reported `onDirty`, so the page's `dirty` was blind to the other two and a tab
 * switch destroyed their typing with no prompt at all.
 *
 * A plain second `useState` per child would have recreated a clobber the single
 * flag avoids only by accident (one reporter). The page keeps a SET of dirty
 * sources instead, so three components on one tab compose rather than overwrite.
 */
describe('ADR 0598 §Correction 5 — every draft-holder on the tab is guarded, not just the editor', () => {
  const MEASURED: Strategy = {
    ...STRATEGY,
    objectives: [{ id: 'o1', title: 'Grow pipeline', keyResults: [{ id: 'k1', title: 'MQLs 2x', measure: { kind: 'numeric', target: 100 } }] }],
  };

  it('an unsaved CSV import draft prompts before the tab switch', async () => {
    confirmMock.mockResolvedValue(false);
    await view('objectives');
    fireEvent.change(await screen.findByLabelText(/^csv$/i), { target: { value: 'Expand EMEA,Open 3 offices' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
    expect(screen.getByDisplayValue('Expand EMEA,Open 3 offices')).toBeTruthy();
  });

  it('an unsaved CHECK-IN draft prompts before the tab switch', async () => {
    confirmMock.mockResolvedValue(false);
    getStrategy.mockImplementation(async () => structuredClone(MEASURED));
    await view('objectives');
    fireEvent.change(await screen.findByLabelText(/^value$/i), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
  });

  it('a check-in NOTE alone counts — it is the half with no numeric tell', async () => {
    confirmMock.mockResolvedValue(false);
    getStrategy.mockImplementation(async () => structuredClone(MEASURED));
    await view('objectives');
    fireEvent.change(await screen.findByLabelText(/^note$/i), { target: { value: 'Held back by hiring' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
  });

  it('typing into the CSV box and CLEARING it is clean again (the over-fire control)', async () => {
    await view('objectives');
    const csv = await screen.findByLabelText(/^csv$/i);
    fireEvent.change(csv, { target: { value: 'Expand EMEA' } });
    fireEvent.change(csv, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('the objectives EDITOR still reports independently — the registry composes, it does not overwrite', async () => {
    // The failure a plain second `useState` would have produced: the last
    // reporter to run its effect wins, so a clean import block would erase a
    // dirty editor. Both are dirty here; leaving must still prompt.
    confirmMock.mockResolvedValue(false);
    await view('objectives');
    fireEvent.change(await screen.findByDisplayValue('Grow pipeline'), { target: { value: 'Grow pipeline in EMEA' } });
    fireEvent.change(screen.getByLabelText(/^csv$/i), { target: { value: 'Expand EMEA' } });
    // Clear ONLY the import draft. The editor is still dirty.
    fireEvent.change(screen.getByLabelText(/^csv$/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: /initiatives/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalled();
  });
});

describe('SPU-5 — the timeline failure is announced AND recoverable', () => {
  it('offers a Retry that re-runs the read, instead of demanding a page reload', async () => {
    // This was the ONLY failure in the feature with no Retry; every other one has
    // offered it since R2. A user whose timeline read 429s had to reload the page,
    // on a route CLAUDE.md already flags for read-budget fan-out.
    getStrategyTimeline.mockRejectedValueOnce(new Error('timeline 429'));
    getStrategyTimeline.mockResolvedValue([{ kind: 'initiative', id: 'i1', title: 'Ship it', dueDate: '2026-09-01', source: { strategyId: 's1', kind: 'initiative' } }]);
    await view('timeline');
    expect(await screen.findByText(/could not load the timeline/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(getStrategyTimeline.mock.calls.length).toBeGreaterThan(1));
    // Positive control: the retry really re-read and really rendered.
    expect(await screen.findByText('Ship it')).toBeTruthy();
    expect(screen.queryByText(/could not load the timeline/i)).toBeNull();
  });

  it('the failure is SPOKEN, not merely rendered', async () => {
    const before = currentAnnouncements().assertive;
    getStrategyTimeline.mockRejectedValue(new Error('timeline 429'));
    await view('timeline');
    await screen.findByText(/could not load the timeline/i);
    // `variant="error"` announces ASSERTIVELY via `ui/Notice.tsx:80`. Asserted as a
    // DELTA so the module-global announcer cannot make this order-dependent.
    await waitFor(() => expect(currentAnnouncements().assertive).not.toBe(before));
    expect(currentAnnouncements().assertive).toContain('Could not load the timeline');
  });
});

describe('SPU-5 — the WHOLE-PAGE load failure is announced', () => {
  /**
   * This one has NO gate witness and that is the point of writing it by hand.
   * The extended `check-notice-announce` reads a 60-character window before the
   * element, and this Notice sits two elements below its `if (loadError) { return (`
   * — MEASURED: removing its `announce` leaves the gate GREEN. Sabotage proves an
   * assertion is load-bearing; it cannot invent the assertion nobody wrote, so
   * the shape the gate cannot reach gets a hand-written one.
   */
  it('a failed strategy read speaks, instead of leaving a silent error page', async () => {
    const before = currentAnnouncements().assertive;
    getStrategy.mockRejectedValue(new Error('strategy 500'));
    await view('overview');
    expect(await screen.findByText('strategy 500')).toBeTruthy();
    await waitFor(() => expect(currentAnnouncements().assertive).not.toBe(before));
    expect(currentAnnouncements().assertive).toContain('strategy 500');
  });
});

describe('SPU-6 — a failed priority-context resolve is disclosed, not shown as "unranked"', () => {
  const LINKED: Strategy = { ...STRATEGY, links: [{ kind: 'priority-idea', listId: 'l1', cardId: 'c1' }] };

  it('says the priority details could not be loaded, instead of just showing raw ids', async () => {
    getStrategyDetailContext.mockRejectedValue(new Error('context 429'));
    getStrategy.mockImplementation(async () => structuredClone(LINKED));
    await view('alignment');
    expect(await screen.findByText(/could not load the priority details/i)).toBeTruthy();
    // The degraded render is still there — the disclosure is additive, not a
    // replacement. Losing the link row would be a worse fix than the bug.
    expect(screen.getByText('l1 · c1')).toBeTruthy();
  });

  it('a SUCCESSFUL resolve says nothing (the negative control)', async () => {
    const ctx: StrategyContextEntry = {
      id: 's1', title: STRATEGY.title, scope: 'org', orgId: 'org-1', horizon: 'annual', period: { label: '2026' },
      status: 'active', objectives: [], initiatives: [], linkedProjects: [],
      linkedPriorities: [{ listId: 'l1', cardId: 'c1', title: 'Ship onboarding', rank: 3 }],
    };
    getStrategyDetailContext.mockResolvedValue(ctx);
    getStrategy.mockImplementation(async () => structuredClone(LINKED));
    await view('alignment');
    expect(await screen.findByText('Ship onboarding')).toBeTruthy();
    expect(screen.queryByText(/could not load the priority details/i)).toBeNull();
  });

  it('a failure with NO priority link stays quiet — nothing was degraded', async () => {
    // The over-fire control: `ctx` resolves labels for priority links only, so on
    // a strategy with none the failed resolve changed nothing on screen and the
    // warning would be noise about a non-event.
    getStrategyDetailContext.mockRejectedValue(new Error('context 429'));
    await view('alignment');
    await screen.findByText(/link the projects and priorities/i);
    expect(screen.queryByText(/could not load the priority details/i)).toBeNull();
  });
});

describe('SPU-7 — the project-overview chips separate "toggle off" from "the read failed"', () => {
  it('a TRANSIENT failure shows the failed state, not an empty section', async () => {
    getStrategyContext.mockRejectedValue(new Error('context 429'));
    render(<MemoryRouter><ProjectStrategyChips projectId="p1" /></MemoryRouter>);
    // Rendering nothing would CLAIM this project is aligned to no strategy; a PM
    // acts on that by re-linking it, creating a duplicate.
    expect(await screen.findByText(/strategy alignment could not be loaded/i)).toBeTruthy();
  });

  it('the toggle being OFF still renders nothing (the cause that IS a complete answer)', async () => {
    getStrategyContext.mockRejectedValue(new FeatureDisabledError('strategy'));
    const { container } = render(<MemoryRouter><ProjectStrategyChips projectId="p1" /></MemoryRouter>);
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('a genuinely unaligned project still renders nothing (the negative control)', async () => {
    getStrategyContext.mockResolvedValue([]);
    const { container } = render(<MemoryRouter><ProjectStrategyChips projectId="p1" /></MemoryRouter>);
    await act(async () => {});
    expect(container.textContent).toBe('');
  });
});

describe('SPU-9 — the blocked-save copy is pluralized, in the case that actually happens', () => {
  // The ONE-blank (singular) arm lives in strategyR3.test.tsx R3-A case 1 (w19 cut).
  it('TWO blank titles still read as a plural sentence (the other arm)', async () => {
    await view('objectives');
    fireEvent.change(await screen.findByDisplayValue('Grow pipeline'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('Retain the base'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/^2 items have an empty title/)).toBeTruthy();
  });
});

describe('SPU-10 — key-result groups are attributed to the objective that owns them', () => {
  it('the KR group names its objective, so "Key result 1" is not ambiguous across objectives', async () => {
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    // `ki` restarts at 1 for every objective, so on a four-objective strategy a
    // screen reader read "Key result 1, Key result 2, Key result 1, …" with
    // nothing tying a group to its owner — and editing the wrong one is hard to
    // recover from, because there is no undo.
    expect(screen.getByRole('group', { name: 'Key result 1 of Grow pipeline' })).toBeTruthy();
  });

  it('the objective container itself has an accessible name', async () => {
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    expect(screen.getByRole('group', { name: 'Objective 1: Grow pipeline' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Objective 2: Retain the base' })).toBeTruthy();
  });

  it('a NEW, untitled objective is still named rather than anonymous', async () => {
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /add objective/i }));
    expect(await screen.findByRole('group', { name: 'Objective 3: untitled' })).toBeTruthy();
  });
});

describe('SPU-11 — the error is brought to the user, not left off-screen above', () => {
  it('raising an error moves FOCUS to it', async () => {
    await view('objectives');
    fireEvent.change(await screen.findByDisplayValue('Grow pipeline'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const notice = await screen.findByText(/an empty title/i);
    const holder = notice.closest('[tabindex="-1"]');
    expect(holder).not.toBeNull();
    // Every error renders under the PageHeader; every Save button is at the bottom
    // of an editor several viewports tall. Focus is what makes the explanation
    // reachable for a keyboard user and (via the browser's scroll-on-focus) visible
    // for a sighted one.
    //
    // ASSERTED AS AN IDENTITY, and the first cut of this was VACUOUS: it read
    // `document.activeElement?.contains(notice)`, which is TRUE when
    // `activeElement` is `document.body` — i.e. it passed with the focus effect
    // deleted. Caught by the sabotage probe, which is what the probe is for.
    await waitFor(() => expect(document.activeElement).toBe(holder));
  });

  /**
   * ADR 0598 §Correction 6 — the SECOND identical failure.
   *
   * `setError` with an `Object.is`-equal string is a React bail-out: nothing
   * re-renders, so `useEffect(…, [error])` does not re-fire (no focus move) and
   * the `Notice`'s `useEffect(…, [announce, assertive])` does not re-fire
   * either — the notice is already mounted and its prop is unchanged. Retrying
   * a failing save and getting the same message back was therefore TOTAL
   * SILENCE and no focus movement: indistinguishable from the button doing
   * nothing, which is the §2 defect arriving through the failure path.
   *
   * §7 defect 3 reasoned exactly this way about `templateApplied` one commit
   * earlier and the conclusion was not carried across.
   */
  it('a REPEATED identical failure re-announces and re-focuses', async () => {
    updateStrategy.mockRejectedValue(new Error('strategy 500'));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    const save = screen.getByRole('button', { name: /^save$/i });

    fireEvent.click(save);
    const notice = await screen.findByText('strategy 500');
    const holder = notice.closest('[tabindex="-1"]');
    expect(holder).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(holder));
    // The announcement comes from a passive effect that can flush after findBy sees the DOM; wait for it.
    await waitFor(() => expect(currentAnnouncements().assertive).toContain('strategy 500'));
    const afterFirst = currentAnnouncements().assertive;

    // The user does the only sensible thing: press Save again. Focus is now on
    // the button, and the server returns the SAME message.
    (save as HTMLElement).focus();
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);

    // Asserted as an IDENTITY change, not as content: the announcer alternates
    // an invisible marker on a repeat, so a re-announcement is a CHANGED value
    // carrying the same words. Comparing the words alone would pass without it.
    await waitFor(() => expect(currentAnnouncements().assertive).not.toBe(afterFirst));
    expect(currentAnnouncements().assertive).toContain('strategy 500');
    // `holder`, not `notice.closest(…)`: the NOTICE is remounted by the tick, so
    // the original node is detached and `closest` would return null — an
    // assertion that passes for the wrong reason. The holder is stable.
    await waitFor(() => expect(document.activeElement).toBe(holder));
  });

  it('the focus effect does NOT fire on an unrelated re-render (the over-fire control)', async () => {
    // Re-running the focus effect every render would steal focus from a field
    // being typed in — a worse defect than the one above. Typing must not move
    // focus while an error is standing.
    updateStrategy.mockRejectedValue(new Error('strategy 500'));
    await view('objectives');
    const title = await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText('strategy 500');
    (title as HTMLElement).focus();
    fireEvent.change(title, { target: { value: 'Grow pipeline in EMEA' } });
    await act(async () => {});
    expect(document.activeElement).toBe(title);
  });
});

describe('SPU-13 — the Check-ins panel explains its prerequisite instead of vanishing', () => {
  it('a strategy with no measured key result gets a designed empty state, not nothing', async () => {
    await view('objectives');
    // It used to `return null`: no section, no heading, no hint that the
    // prerequisite is setting "Measurement" on a key result. The copy that would
    // have explained it rendered only AFTER the precondition was already met.
    expect(await screen.findByText(/nothing is measured yet/i)).toBeTruthy();
    expect(screen.getByText(/needs a Measurement before it can be checked in on/i)).toBeTruthy();
  });

  it('a MEASURED key result shows the real trail instead (the negative control)', async () => {
    const MEASURED: Strategy = {
      ...STRATEGY,
      objectives: [{ id: 'o1', title: 'Grow pipeline', keyResults: [{ id: 'k1', title: 'MQLs 2x', measure: { kind: 'numeric', target: 100 } }] }],
    };
    getStrategy.mockImplementation(async () => structuredClone(MEASURED));
    await view('objectives');
    expect(await screen.findByText(/record measured progress on each key result/i)).toBeTruthy();
    expect(screen.queryByText(/nothing is measured yet/i)).toBeNull();
  });
});

describe('ADR 0597 §Correction 4 residual — the withdrawn activation review reaches the screen', () => {
  // The two disclosure arms (Objectives + Overview) are asserted by the §Correction 4
  // describe below, which also pins that no second toast fires (w19 cut). This
  // over-fire control is the half only this describe holds.
  it('an ordinary save says nothing about reviews (the over-fire control)', async () => {
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(screen.queryByText(/that review was withdrawn/i)).toBeNull();
  });
});

/**
 * ADR 0598 §Correction 4 — ONE MESSAGE PER SAVE, applied to the flag that
 * arrived after the rule was written.
 *
 * `ui/announce.tsx` keeps ONE module-level `politeMsg`. Two polite messages for
 * one save means the second overwrites the first, so the user hears whichever
 * landed last — and the withdrawal disclosure is the one that matters.
 *
 * §2 wrote the rule and enforced it against `autoRevertedToDraft` only.
 * `activationReviewClosed` was added by §8 one commit later and the suppression
 * term was never extended, so a withdrawal save fired an unconditional
 * `toast.success` (`ui/toast.tsx:69` announces it) ALONGSIDE the announcing
 * disclosure. The R4 spec above mocked the toast and never asserted it was not
 * called, which is why the rule could be broken by the next commit in the same PR.
 */
describe('ADR 0598 §Correction 4 — a save that withdraws a review speaks ONCE', () => {
  it('the OVERVIEW withdrawal disclosure IS the confirmation — no second toast', async () => {
    updateStrategy.mockResolvedValue(saved({ activationReviewClosed: true }));
    await view('overview');
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/that review was withdrawn/i)).toBeTruthy();
    // "Saved — but … that review was withdrawn" already says the save worked.
    // A plain "Strategy saved" behind it in the polite queue describes strictly
    // less and displaces the part the user has to act on.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('the OBJECTIVES withdrawal disclosure IS the confirmation — no second toast', async () => {
    updateStrategy.mockResolvedValue(saved({ activationReviewClosed: true }));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/that review was withdrawn/i)).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  /**
   * The CO-OCCURRENCE, and it is reachable rather than theoretical. Backend
   * `features/strategy/routes.ts`: `autoReverted` needs `touchesProtected &&
   * protectedEditRequiresReapproval(s.status)` and `activationReviewClosed`
   * needs `touchesProtected && withdrawActivationReview(...)`.
   * `STATUS_GATE_POSTURE.paused` is `{approved: true, terminal: false}`, so
   * `paused` satisfies the first — and a `paused` strategy can hold a PENDING
   * review, because `PATCH {status:'active'}` from `paused` withholds the flip
   * and queues. Recipe: pause → submit for activation → edit objectives.
   * Both flags come back on ONE response.
   */
  it('an auto-revert that ALSO withdraws the review renders ONE combined disclosure', async () => {
    updateStrategy.mockResolvedValue(saved({
      autoRevertedToDraft: true,
      autoRevertedFields: ['objectives'],
      activationReviewClosed: true,
    }));
    await view('objectives');
    await screen.findByDisplayValue('Grow pipeline');
    const before = currentAnnouncements().polite;
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // ONE notice carrying BOTH facts, not two racing for one polite slot.
    const combined = await screen.findByText(/returns it to Draft.*that review was withdrawn/is);
    expect(combined).toBeTruthy();
    // …and neither single-fact disclosure is also on screen.
    expect(screen.queryByText(/^Saved — but editing objectives on an active strategy returns it to Draft, so it needs approving again before it counts as active\.$/)).toBeNull();
    expect(screen.queryByText(/^Saved — but this edit changed content that was awaiting activation approval/)).toBeNull();

    await waitFor(() => expect(currentAnnouncements().polite).not.toBe(before));
    expect(currentAnnouncements().polite).toContain('returns it to Draft');
    expect(currentAnnouncements().polite).toContain('that review was withdrawn');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
