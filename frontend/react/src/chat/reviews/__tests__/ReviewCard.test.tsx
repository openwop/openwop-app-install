import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.mock('../ReviewHandoff.js', () => ({ ReviewHandoff: () => null })); // own tests: reviewHandoff.test.tsx
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReviewCard } from '../ReviewCard.js';
import type { ReviewRequest } from '../reviewClient.js';
import { confirm } from '../../../ui/confirm.js';
import { useReviewStatusStore } from '../reviewStatusStore.js';

vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));
// `/runs/:runId` is admin-tier; the typed-answer fallback depends on the caller.
let admin = false;
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => admin,
}));

afterEach(cleanup);
// Shuffle-safe: every case starts with a fresh `confirm` (no queued once-values or
// calls from an earlier case) that accepts, and an empty kept-failure map.
beforeEach(() => {
  vi.mocked(confirm).mockReset();
  vi.mocked(confirm).mockResolvedValue(true);
  useReviewStatusStore.setState({ failureById: {} });
});
/** Let a resolved promise chain (confirm → decide) run to completion. */
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/**
 * ReviewCard (ADR 0068) — proves the normalized card derives its actions from
 * the backend record (never client-guessed), dispatches the chosen action, and
 * renders read-only when the source reports no available actions (resolved).
 */
const base: ReviewRequest = {
  reviewId: 'approval:appr-1',
  source: 'approval',
  kind: 'run-proposal',
  status: 'pending',
  tenantId: 't1',
  requestedBy: { kind: 'agent', id: 'roster:scout', label: 'Scout' },
  requestedAt: '2026-06-18T00:00:00Z',
  summary: 'Run intake on the Garcia card',
  actions: [{ action: 'approve', label: 'Approve & run' }, { action: 'reject', label: 'Reject' }],
  provenanceRefs: [{ kind: 'card', ref: 'card-1', label: 'New family: Garcia' }],
};

describe('ReviewCard', () => {
  it('renders the summary, source-derived actions, and provenance', () => {
    render(<ReviewCard review={base} onDecide={vi.fn()} />);
    expect(screen.getByText('Run intake on the Garcia card')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve & run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeTruthy();
    expect(screen.getByText('New family: Garcia')).toBeTruthy();
  });

  it('dispatches the chosen action (with the note) to onDecide', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCard review={base} onDecide={onDecide} />);
    fireEvent.change(screen.getByPlaceholderText(/Add a note/), { target: { value: 'looks good' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', { note: 'looks good' }));
  });

  // PRE-1 — this asserted `getByLabelText('Quorum: 1 of 2 approved')`, a container
  // aria-label that #2778 DELIBERATELY removed: on a role-less div it was prohibited
  // and ignored outright (axe `aria-prohibited-attr`), and it duplicated the chip
  // text. The component change was right; the test was not updated with it, so main
  // went red at that merge. Re-pointed at what AT actually announces now — and
  // extended to PIN the decision, so a future "fix" cannot quietly restore the
  // redundant label.
  it('surfaces quorum progress as chip TEXT, not a duplicate container label (ADR 0070 / #2778)', () => {
    const { container } = render(
      <ReviewCard review={{ ...base, policy: { requiredApprovals: 2, approvals: 1, rejections: 1 } }} onDecide={vi.fn()} />,
    );
    // What a screen reader reads: the chips themselves.
    expect(screen.getByText('1 of 2 approved')).toBeTruthy();
    expect(screen.getByText('1 rejected')).toBeTruthy();

    const quorum = container.querySelector('.review-card__quorum');
    expect(quorum, 'fixture guard: the quorum block must render or nothing below is checked').toBeTruthy();

    // The block must NOT carry a name that duplicates the chips — that is the
    // regression #2778 fixed, and re-adding it would make AT announce the summary
    // INSTEAD of the chips.
    expect(quorum!.getAttribute('aria-label'), 'the container label was removed on purpose').toBeNull();

    // The meter is decorative and must stay hidden, or it doubles the announcement.
    const meter = container.querySelector('.review-card__quorum-meter');
    expect(meter?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders read-only (no action buttons, no note field, the status shown) once the source reports no actions', () => {
    render(<ReviewCard review={{ ...base, status: 'approved', actions: [] }} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
    // The decision UI is gone, not merely empty: no note field to type into…
    expect(screen.queryByRole('textbox')).toBeNull();
    // …and the resolved status is stated (StatusBadge renders the raw status).
    expect(screen.getByText('approved')).toBeTruthy();
  });

  describe('ADR 0778 D10 correction — a typed answer is collected on the card', () => {
    afterEach(() => { admin = false; });
    const typed = (over: Partial<ReviewRequest>): ReviewRequest => ({
      ...base, reviewId: 'interrupt:i1', source: 'interrupt', kind: 'clarification', runId: 'run-1', nodeId: 'ask',
      actions: [{ action: 'resolve', label: 'Submit', requiresValue: true }], provenanceRefs: [],
      ...over,
    });

    it('a member answers a clarification inline; the value is posted, never an invented `{}`', async () => {
      const onDecide = vi.fn().mockResolvedValue(undefined);
      render(<MemoryRouter><ReviewCard review={typed({ answerForm: { question: 'Which colour?' } })} onDecide={onDecide} /></MemoryRouter>);
      expect(screen.getByText('Which colour?')).toBeTruthy();
      expect(document.querySelector('a[href^="/runs/"]')).toBeNull();
      const field = screen.getByRole('textbox', { name: /answer/i });
      // A list of review cards must not steal focus on mount.
      expect(document.activeElement).not.toBe(field);
      fireEvent.change(field, { target: { value: 'the blue one' } });
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
      await waitFor(() => expect(onDecide).toHaveBeenCalledWith('resolve', { value: { answer: 'the blue one' } }));
    });

    it('a refinement starts from the draft and posts the edit', async () => {
      const onDecide = vi.fn().mockResolvedValue(undefined);
      render(<MemoryRouter><ReviewCard review={typed({ kind: 'refinement', answerForm: { current: 'Draft one' } })} onDecide={onDecide} /></MemoryRouter>);
      const field = screen.getByRole('textbox', { name: /draft/i }) as HTMLTextAreaElement;
      expect(field.value).toBe('Draft one');
      fireEvent.change(field, { target: { value: 'Draft two' } });
      fireEvent.click(screen.getByRole('button', { name: /submit refinement/i }));
      await waitFor(() => expect(onDecide).toHaveBeenCalledWith('resolve', { value: { refinement: 'Draft two' } }));
    });

    it('a kind the card cannot answer: an admin gets the run link, a member is told who can answer — never a dead link', () => {
      const onDecide = vi.fn();
      admin = true;
      render(<MemoryRouter><ReviewCard review={typed({ kind: 'external-event' })} onDecide={onDecide} /></MemoryRouter>);
      expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull();
      expect(screen.getByRole('link', { name: /Answer on the run page/ }).getAttribute('href')).toBe('/runs/run-1');
      cleanup();

      admin = false;
      render(<MemoryRouter><ReviewCard review={typed({ kind: 'external-event' })} onDecide={onDecide} /></MemoryRouter>);
      expect(document.querySelector('a[href^="/runs/"]')).toBeNull();
      expect(screen.getByText(/A workspace admin can answer it/)).toBeTruthy();
      expect(onDecide).not.toHaveBeenCalled();
    });
  });

  it('ADR 0778 APUX-3 — canDecide:false offers no decision, and says why', () => {
    render(<ReviewCard review={{ ...base, canDecide: false }} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Approve & run/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
    // An approval-source review names the reason (closing review I5).
    expect(screen.getByText(/Only the approvers named on this request/)).toBeTruthy();
    cleanup();
    render(<ReviewCard review={{ ...base, reviewId: 'interrupt:x', source: 'interrupt', kind: 'approval', canDecide: false }} onDecide={vi.fn()} />);
    expect(screen.getByText(/don't have permission to respond/)).toBeTruthy();
  });

  it('ADR 0778 APUX-9 — reject asks first; a declined confirm posts nothing', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCard review={base} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    await drain(); // the declined answer has settled — anything it would post, it has
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('ADR 0778 APUX-10 — a same-tick double click posts once', async () => {
    let release!: () => void;
    const onDecide = vi.fn(() => new Promise<void>((r) => { release = r; }));
    render(<ReviewCard review={base} onDecide={onDecide} />);
    const approve = screen.getByRole('button', { name: /Approve & run/ }) as HTMLButtonElement;
    // Both clicks inside ONE act: no re-render between them, so the `disabled`
    // state cannot be what drops the second (fireEvent flushes per call, which
    // is why a fireEvent pair passes even without the ref).
    act(() => { approve.click(); approve.click(); });
    expect(onDecide).toHaveBeenCalledTimes(1);
    release();
  });

  it('ADR 0778 APUX-1/5 — a failure the store kept is shown on the REMOUNTED card, localized, never raw — and only once', async () => {
    const refused = Object.assign(new Error('forbidden_scope: Missing required scope: approvals:respond'), { httpStatus: 403 });
    useReviewStatusStore.setState({ failureById: { [base.reviewId]: refused } });
    const first = render(<ReviewCard review={base} onDecide={vi.fn()} />);
    expect(await screen.findByText(/permission to do that/i)).toBeTruthy();
    expect(screen.queryByText(/forbidden_scope/)).toBeNull();
    // Consumed by the card that showed it: a later remount does not show (or
    // announce) it again (closing review I1).
    expect(useReviewStatusStore.getState().failureById[base.reviewId]).toBeUndefined();
    first.unmount();
    render(<ReviewCard review={base} onDecide={vi.fn()} />);
    expect(screen.queryByText(/permission to do that/i)).toBeNull();
  });
});

/**
 * ADR 0473 Phase 2 — the composed-workflow proposal section: payload-level
 * preview (steps + role badges), approve-what-you-see (the approve echoes the
 * LIVE hash the card displayed), staleness/expiry notices, builder deep-link.
 */
const composed: ReviewRequest = {
  ...base,
  reviewId: 'approval:appr-cw',
  kind: 'composed-workflow',
  workflowId: 'agent-wf-1',
  workflowName: 'agent-wf-1',
  summary: 'Summarize new leads each morning',
  actions: [{ action: 'approve', label: 'Approve & run' }, { action: 'reject', label: 'Reject' }],
  provenanceRefs: [],
  composedWorkflow: {
    definitionHash: 'pin-1',
    liveDefinitionHash: 'live-2',
    editedSinceProposed: true,
    agentProfileId: 'vendor.openwop-app.workflow-author.agents.workflow-architect',
    nodeCount: 3,
    edgeCount: 2,
    expiresAt: '2099-01-01T00:00:00Z',
    runInputs: { segment: 'new-leads' },
    steps: [
      { nodeId: 'a', typeId: 'feature.crm.nodes.search', role: 'read' },
      { nodeId: 'b', typeId: 'vendor.openwop-app.chat-responder', role: 'unclassified' },
    ],
  },
};

describe('ReviewCard composed-workflow section (ADR 0473)', () => {
  it('renders steps with role badges, the evidence line, and the builder deep-link', async () => {
    render(<MemoryRouter><ReviewCard review={composed} onDecide={vi.fn()} /></MemoryRouter>);
    // The section is lazy-loaded (entry-budget split) — await its first paint.
    expect(await screen.findByText('feature.crm.nodes.search')).toBeTruthy();
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.getByText('unclassified')).toBeTruthy();
    expect(screen.getByText(/3 nodes/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open in builder/ });
    expect(link.getAttribute('href')).toBe('/builder/agent-wf-1');
  });

  it('shows the edited-since-proposed notice and approves with the LIVE hash (approve-what-you-see)', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={composed} onDecide={onDecide} /></MemoryRouter>);
    expect(await screen.findByText(/Edited since proposed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', { expectedDefinitionHash: 'live-2' }));
  });

  it('no live view ⇒ no unpinned Approve; Reject stays (grade-ux U2)', async () => {
    const { liveDefinitionHash: _absent, ...withoutLive } = composed.composedWorkflow!;
    const degraded: ReviewRequest = { ...composed, composedWorkflow: withoutLive };
    render(<MemoryRouter><ReviewCard review={degraded} onDecide={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('feature.crm.nodes.search')).toBeTruthy(); // section settled
    expect(screen.queryByRole('button', { name: /Approve & run/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Reject$/ })).toBeTruthy();
  });

  it('reject does NOT carry the hash (only approve pins what was seen)', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={composed} onDecide={onDecide} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('reject', {}));
  });

  it('renders the expired notice and the frozen run inputs', async () => {
    const expired = { ...composed, composedWorkflow: { ...composed.composedWorkflow!, expired: true } };
    render(<MemoryRouter><ReviewCard review={expired} onDecide={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText(/Expired — ask the agent/)).toBeTruthy();
    expect(screen.getByText('Run inputs')).toBeTruthy();
  });

  it('shows the reviewer note on a resolved card', () => {
    const resolved: ReviewRequest = { ...composed, status: 'rejected', actions: [], decisionNote: 'use the CRM chain instead' };
    render(<MemoryRouter><ReviewCard review={resolved} onDecide={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('use the CRM chain instead')).toBeTruthy();
  });
});

describe('ADR 0862 — an assistant action review', () => {
  const action: ReviewRequest = {
    ...base,
    kind: 'assistant-action',
    actions: [{ action: 'approve', label: 'Approve' }, { action: 'reject', label: 'Reject' }],
    assistantAction: {
      actionId: 'act:1', kind: 'email.send', contentHash: 'hash-v1',
      payload: { to: ['dana@example.com'], subject: 'Q3 numbers' },
    },
  };

  it('renders the fields the action will send, and approve echoes the hash of what is shown', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={action} onDecide={onDecide} /></MemoryRouter>);
    expect(await screen.findByText('Q3 numbers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', { expectedContentHash: 'hash-v1' }));
  });

  it('a reject carries no hash (refusing a changed action is still a refusal)', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={action} onDecide={onDecide} /></MemoryRouter>);
    // AssistantActionFields is lazy and NOT in its own Suspense: until its chunk
    // loads the whole card shows the loading fallback (no buttons). Wait for the
    // real settle signal — under shuffle this case can run before the chunk is cached.
    expect(await screen.findByText('Q3 numbers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('reject', {}));
  });

  it('a withheld or unavailable card offers no decision and names the permission remedy', () => {
    const onDecide = vi.fn();
    const unavailable: ReviewRequest = { ...action, canDecide: false };
    delete unavailable.assistantAction;
    render(<ReviewCard review={unavailable} onDecide={onDecide} />);
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject$/ })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Ask an admin of this workspace for access/)).toBeTruthy();
    expect(screen.queryByText(/Only the approvers named on this request/)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });
});
