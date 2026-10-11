/**
 * UX_UPGRADE-advisory-board — ADV-G1.
 *
 * The context-picker reads collapsed two different situations into one silently
 * absent picker: the strategy/projects FEATURE being off (hiding is correct),
 * and the read simply FAILING (hiding is a lie of omission — the author loses
 * the ability to attach context and is never told the option exists).
 *
 * The discriminator was already there and already evaluated: the strategy catch
 * tested `instanceof FeatureDisabledError` and threw the answer away into an
 * empty block commented `/* transient *\/`.
 *
 * Sabotage-witnessed (/grade-tests w12): hiding the Notice reds the failure arms; flagging a
 * FeatureDisabledError as a failure reds the OFF arm; not flagging the projects failure reds
 * the mixed arm; never marking strategy ON reds the healthy arm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { AdvisoryBoard, OrgRef, RosterMember } from '../advisoryBoardClient.js';
import type { Strategy } from '../../strategy/strategyClient.js';
import type { Project } from '../../projects/projectsClient.js';

const listStrategiesForContext = vi.fn<() => Promise<Strategy[]>>();
const listProjectsForContext = vi.fn<() => Promise<Project[]>>();
const listBoards = vi.fn<() => Promise<AdvisoryBoard[]>>();
const listOrgs = vi.fn<() => Promise<OrgRef[]>>();
const listRoster = vi.fn<() => Promise<RosterMember[]>>();

const TS = '2026-01-01T00:00:00.000Z';
const STRATEGY: Strategy = {
  id: 's1', tenantId: 't', orgId: 'org-1', scope: 'org', title: 'Win mid-market', planningHorizon: 'annual',
  period: { label: 'FY26' }, status: 'active', objectives: [], initiatives: [], links: [],
  createdBy: 'user:me', createdAt: TS, updatedAt: TS,
};
const PROJECT: Project = { id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'kb-1' };

// Must be hoisted: `vi.mock` factories are lifted above top-level declarations,
// so a plain `class` here is not yet defined when the factory runs.
const { FeatureDisabledError } = vi.hoisted(() => {
  class FeatureDisabledError extends Error {}
  return { FeatureDisabledError };
});

// The context reads come from the STRATEGY and PROJECTS clients, not this
// feature's own — the page aliases them on import.
vi.mock('../../strategy/strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FeatureDisabledError,
  listStrategies: () => listStrategiesForContext(),
}));
vi.mock('../../projects/projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listProjects: () => listProjectsForContext(),
}));
vi.mock('../advisoryBoardClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listBoards: () => listBoards(),
  listOrgs: () => listOrgs(),
  listRoster: () => listRoster(),
  getSharedKnowledge: vi.fn(async () => []),
  createBoard: vi.fn(async () => ({})),
  updateBoard: vi.fn(async () => ({})),
  deleteBoard: vi.fn(async () => {}),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { AdvisoryBoardPage } from '../AdvisoryBoardPage.js';

/** The context pickers live in the create/edit form, which is hosted in a modal —
 *  open it before asserting on anything inside. */
const view = async (): Promise<void> => {
  render(<MemoryRouter><AdvisoryBoardPage /></MemoryRouter>);
  await act(async () => {});
  // Two "New board" buttons render on an empty workspace (header + empty state);
  // either opens the same form.
  fireEvent.click((await screen.findAllByRole('button', { name: /new board/i }))[0]!);
  await screen.findByRole('dialog');
  await waitFor(() => expect(listStrategiesForContext).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [listStrategiesForContext, listProjectsForContext, listBoards, listOrgs, listRoster]) m.mockReset();
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listBoards.mockResolvedValue([]);
  // The form short-circuits to "No advisor agents yet" on an empty roster and
  // never renders the context pickers — so the roster has to be non-empty for
  // any of this to be reachable.
  listRoster.mockResolvedValue([{ rosterId: 'r1', persona: 'The Economist' }]);
  listStrategiesForContext.mockResolvedValue([STRATEGY]);
  listProjectsForContext.mockResolvedValue([PROJECT]);
});
afterEach(cleanup);

describe('ADV-G1: a failed context read is not the same as the feature being off', () => {
  it('a genuine FAILURE says the context could not be loaded — and that saved context is left alone', async () => {
    listStrategiesForContext.mockRejectedValue(new Error('strategy store down'));
    listProjectsForContext.mockRejectedValue(new Error('projects store down'));
    await view();
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
    // The save deliberately omits contextRefs in this state; saying so is what
    // stops the warning reading as "your context is gone". (One Notice carries both
    // sentences, so this was a separate case asserting the same element — merged, w12.)
    expect(screen.getByText(/left untouched/i)).toBeTruthy();
  });

  it('the feature being OFF stays silent — hiding is correct there', async () => {
    listStrategiesForContext.mockRejectedValue(new FeatureDisabledError('off'));
    listProjectsForContext.mockRejectedValue(new FeatureDisabledError('off'));
    await view();
    // `view()` settles only on `listStrategiesForContext` having been CALLED, so
    // flush the rejections before asserting anything is absent — otherwise this
    // reads the tree mid-flight and "silent" is indistinguishable from "not yet".
    await act(async () => {});
    // POSITIVE ANCHOR: absence-only, this arm would have passed against a form
    // that rendered nothing at all. The advisor chip proves the form is on
    // screen AND populated, so the silence below is a real observation about a
    // rendered form rather than an artefact of an empty tree.
    expect(screen.getByRole('button', { name: /The Economist/ })).toBeTruthy();
    // A toggle that is off is not a problem to report…
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    // …and the planning-context section is correctly absent, not merely quiet.
    expect(screen.queryByText('Planning context')).toBeNull();
  });

  it('ONE feature off and the other failing still reports the failure', async () => {
    listStrategiesForContext.mockRejectedValue(new FeatureDisabledError('off'));
    listProjectsForContext.mockRejectedValue(new Error('projects down'));
    await view();
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
  });

  it('a healthy read renders the pickers and says nothing', async () => {
    await view();
    expect(await screen.findByText('Win mid-market')).toBeTruthy();
    expect(screen.getByText('Atlas')).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
