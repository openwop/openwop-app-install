/**
 * FRGATE-5 — a failed workspace read is not an empty workspace list.
 *
 * `client.listOrgs().catch(() => [])` fed the create form's workspace select.
 * On failure the select rendered with NO options, `effectiveOrg` fell to `''`,
 * and the Create button sat permanently `disabled` — a DEAD CONTROL with nothing
 * on screen saying why. That is worse than a wrong sentence: a user can argue
 * with a sentence.
 *
 * Fixed by adopting `ui/useOrgSelection`, which already owns exactly this: it
 * keeps `orgs` NULL until the read resolves (never `[]` as a failure sentinel),
 * and exposes `orgsFailed` + `retry`. I had assumed the hook could not take an
 * injected `client.listOrgs`; it takes the lister as its first argument, so that
 * assumption was wrong and the bespoke flag it would have justified is gone.
 *
 * Both polarities on every arm. An "absent" assertion alone is vacuous — a panel
 * that rendered nothing would satisfy it — and the success arm is what stops a
 * fix from deleting a correct empty state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

import { SubjectKnowledgePanel, type SubjectKnowledgeClient } from '../SubjectKnowledgePanel.js';

const copy = { intro: 'intro', subject: 'agent', sourcesHeading: 'Sources' } as never;

const makeClient = (over: Partial<SubjectKnowledgeClient> = {}): SubjectKnowledgeClient => ({
  getKnowledge: vi.fn().mockResolvedValue({ collections: [] }),
  listOrgs: vi.fn().mockResolvedValue([{ orgId: 'o1', name: 'Alpha' }]),
  createCollection: vi.fn(),
  unbindCollection: vi.fn(),
  ingestText: vi.fn(),
  deleteDocument: vi.fn(),
  ...over,
} as unknown as SubjectKnowledgeClient);

const mount = async (client: SubjectKnowledgeClient): Promise<void> => {
  render(<SubjectKnowledgePanel client={client} copy={copy} />);
  await act(async () => {});
};

const UNKNOWN = /could not be loaded|it is unknown/i;

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('FRGATE-5 — a failed workspace read says so', () => {
  it('read FAILS: says UNKNOWN, offers a retry, and the dead button has a reason', async () => {
    await mount(makeClient({ listOrgs: vi.fn().mockRejectedValue(new Error('503')) }));

    expect(screen.getByText(UNKNOWN)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
    // THE DEFECT: the create control was disabled with nothing explaining it.
    expect(screen.getByText(/once the list loads/i)).toBeTruthy();
    // And it must NOT claim the tenant simply has no workspaces.
    expect(screen.queryByText(/no workspaces yet/i)).toBeNull();
  });

  it('read SUCCEEDS with []: the genuine "none yet" copy SURVIVES (other polarity)', async () => {
    await mount(makeClient({ listOrgs: vi.fn().mockResolvedValue([]) }));

    expect(screen.getByText(/no workspaces yet/i)).toBeTruthy();
    // Nothing failed, so nothing may say it did.
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });

  it('read SUCCEEDS with orgs: neither message appears', async () => {
    await mount(makeClient());

    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect(screen.queryByText(/no workspaces yet/i)).toBeNull();
  });

  it('retry actually RE-RUNS the read and recovers — not just a button that renders', async () => {
    const listOrgs = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce([{ orgId: 'o1', name: 'Alpha' }]);
    await mount(makeClient({ listOrgs }));

    expect(screen.getByText(UNKNOWN)).toBeTruthy();
    const before = listOrgs.mock.calls.length;

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again|retry/i })); });

    expect(listOrgs.mock.calls.length).toBe(before + 1);
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });

  it('the knowledge read is INDEPENDENT — orgs failing does not blank the panel', async () => {
    // The two reads used to be co-scheduled in one Promise.all. They are now on
    // separate effects, so this pins that a failure in one does not take the
    // other's content with it.
    const getKnowledge = vi.fn().mockResolvedValue({ collections: [] });
    await mount(makeClient({ getKnowledge, listOrgs: vi.fn().mockRejectedValue(new Error('503')) }));

    expect(getKnowledge).toHaveBeenCalled();
    expect(screen.getByText('intro')).toBeTruthy();
  });
});
