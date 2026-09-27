/**
 * ADR 0596 (`WFAU-1`) — the "opens on the canvas" hand-off.
 *
 * Four locales, the Workflow Architect's system prompt and the persist tool's
 * `note` all promised the authored workflow opens on the builder canvas, and
 * NOTHING implemented it. This pins the wiring that makes the (corrected)
 * promise true: after a turn settles, the panel re-reads the tenant's OWN
 * workflow list, diffs it against the baseline it took when the drawer opened,
 * and renders a real link for anything new.
 *
 * The two negative cases matter as much as the positive one:
 *   - no baseline (the first read failed) ⇒ the panel stays SILENT rather than
 *     presenting every pre-existing workflow as "just authored";
 *   - nothing new ⇒ no link. It never invents a destination.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { announce, currentAnnouncements } from '../../ui/announce.js';

const listWorkflows = vi.fn();
vi.mock('../persistence/backendStore.js', () => ({
  listWorkflows: (...a: unknown[]) => listWorkflows(...(a as [])),
}));

/** Stand in for the shared chat: capture `onTurnSettled` so the test can fire a
 *  turn without booting BYOK, SSE and the whole conversation stack. */
let settle: (() => void) | undefined;
vi.mock('../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: ({ onTurnSettled }: { onTurnSettled?: () => void }) => {
    settle = onTurnSettled;
    return <div data-testid="embedded-chat" />;
  },
}));

const { CreateWithAiPanel } = await import('../CreateWithAiPanel.js');

const row = (id: string, name?: string) => ({ id, nodeCount: 1, ...(name ? { name } : {}) });

beforeEach(() => {
  settle = undefined;
  listWorkflows.mockReset();
  announce(''); // the announcer is module-global; clear it between cases
});
afterEach(cleanup);

function renderPanel(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <CreateWithAiPanel onClose={() => {}} />
    </MemoryRouter>,
  );
}
const mount = (): void => { renderPanel(); };

describe('Create-with-AI hand-off (ADR 0596)', () => {
  it('renders an "open on the canvas" link for a workflow that appeared during the session', async () => {
    listWorkflows
      .mockResolvedValueOnce([row('wf-old')])
      .mockResolvedValueOnce([row('wf-old'), row('wf-new', 'Lead triage')]);
    mount();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settle).toBeTypeOf('function'));
    settle!();
    const link = await screen.findByRole('link', { name: /Lead triage/ });
    expect(link.getAttribute('href')).toBe('/builder/wf-new');
  });

  /**
   * ADR 0596 §Correction 6 — the disclosure used to be a `<div role="status">`
   * that was MOUNTED WITH ITS TEXT ALREADY INSIDE. DESIGN.md §8 forbids that by
   * name: assistive tech registers a live region on insertion and announces
   * subsequent MUTATIONS, so a conditionally-mounted inline region announces
   * approximately nothing — and a test asserting the ATTRIBUTE passes either
   * way. This asserts the ANNOUNCEMENT instead, through the always-mounted
   * `GlobalLiveRegion` (ADR 0363 P4), and pins it to the visible copy so the two
   * cannot drift.
   */
  it('announces the hand-off through the SHARED region, with the same words it shows', async () => {
    listWorkflows
      .mockResolvedValueOnce([row('wf-old')])
      .mockResolvedValueOnce([row('wf-old'), row('wf-new', 'Lead triage')]);
    const { container } = renderPanel();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settle).toBeTypeOf('function'));
    settle!();
    await screen.findByRole('link', { name: /Lead triage/ });

    const visible = container.querySelector('p.u-fs-12');
    expect(visible?.textContent, 'the disclosure must still be VISIBLE').toBeTruthy();
    // `withRepeatMark` may append a zero-width space to force a re-read.
    expect(currentAnnouncements().polite.replace(/​/g, '')).toBe(visible!.textContent);
    // …and the block must NOT be its own live region (the shape DESIGN.md bans).
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('says nothing when the turn authored nothing', async () => {
    listWorkflows
      .mockResolvedValueOnce([row('wf-old')])
      .mockResolvedValueOnce([row('wf-old')]);
    mount();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settle).toBeTypeOf('function'));
    settle!();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('link')).toBeNull();
  });

  /**
   * ADR 0596 §Correction 8 — this case used to assert
   * `expect(listWorkflows).toHaveBeenCalledTimes(1)` after the turn settled, i.e.
   * it pinned the DEFECT as the guarantee: one transient baseline-read failure
   * disabled the hand-off for the rest of the browser session, because the panel
   * never unmounts and nothing re-tried. Silence is the right polarity; PERMANENT
   * silence was incidental. The contract is now "silent THIS turn, working from
   * the next one on".
   */
  it('a FAILED baseline read keeps the hand-off silent THIS turn — and recovers on the next', async () => {
    listWorkflows
      .mockRejectedValueOnce(new Error('offline'))                                  // baseline read loses
      .mockResolvedValueOnce([row('wf-old'), row('wf-other', 'Someone else')])      // turn 1: adopted as baseline
      .mockResolvedValueOnce([row('wf-old'), row('wf-other'), row('wf-new', 'Lead triage')]); // turn 2
    mount();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settle).toBeTypeOf('function'));

    settle!();
    // Turn 1 READS (that is the recovery), but claims nothing: `wf-other` is a
    // pre-existing workflow and must never be offered as "just authored".
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('link')).toBeNull();

    settle!();
    const link = await screen.findByRole('link', { name: /Lead triage/ });
    expect(link.getAttribute('href')).toBe('/builder/wf-new');
    // …and still nothing for the pre-existing row the adopted baseline covered.
    expect(screen.queryByRole('link', { name: /Someone else/ })).toBeNull();
  });

  /**
   * ADR 0596 §Correction 7 — the diff window. `R8` claimed it was "one chat
   * turn"; it was the PANEL'S WHOLE LIFETIME, which never ends (BuilderShell
   * mounts the panel once, the drawer hides via CSS, and BuilderShell survives
   * navigation between workflows). So a workflow the USER hand-built between
   * turns was attributed to the model on the surface whose entire purpose is
   * honest attribution.
   */
  /**
   * The assertion that MATTERS for per-turn re-baselining, arrived at by
   * sabotage. The obvious one — "turn 2 shows both links" — is VACUOUS: because
   * the list accumulates with de-duplication, an un-re-baselined diff produces
   * the identical rendered set, and disabling the re-baseline reddened NOTHING.
   * The observable difference is the ANNOUNCEMENT: without re-baselining,
   * `fresh` never empties, so every later turn re-runs `announce` with the same
   * sentence — and `withRepeatMark` deliberately makes a repeat audible again.
   * A screen-reader user would be told "a new workflow appeared" on every turn
   * for the rest of the session.
   */
  it('re-baselines every turn: an unchanged list does not re-announce, and keeps the link', async () => {
    listWorkflows
      .mockResolvedValueOnce([row('wf-old')])                                       // baseline
      .mockResolvedValueOnce([row('wf-old'), row('wf-new', 'Lead triage')])         // turn 1: genuinely new
      .mockResolvedValueOnce([row('wf-old'), row('wf-new', 'Lead triage')])         // turn 2: nothing happened
      .mockResolvedValueOnce([row('wf-old'), row('wf-new', 'Lead triage'), row('wf-2', 'Second')]); // turn 3
    mount();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settle).toBeTypeOf('function'));

    settle!();
    await screen.findByRole('link', { name: /Lead triage/ });
    expect(currentAnnouncements().polite).not.toBe('');
    announce(''); // clear, so any re-announcement below is unambiguous

    settle!();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(currentAnnouncements().polite, 'a turn that changed nothing must say nothing').toBe('');
    // …and the link the user may be about to click is still there.
    expect(screen.getAllByRole('link')).toHaveLength(1);

    settle!();
    await screen.findByRole('link', { name: /Second/ });
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('re-baselines when the drawer REOPENS — the closed window is not attributed to the next turn', async () => {
    listWorkflows
      .mockResolvedValueOnce([row('wf-old')])                                   // open #1 baseline
      .mockResolvedValueOnce([row('wf-old'), row('wf-hand', 'Hand built')])     // open #2 baseline (user made one meanwhile)
      .mockResolvedValueOnce([row('wf-old'), row('wf-hand', 'Hand built')]);    // the turn after reopening
    const { rerender } = render(
      <MemoryRouter><CreateWithAiPanel onClose={() => {}} open /></MemoryRouter>,
    );
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(1));
    rerender(<MemoryRouter><CreateWithAiPanel onClose={() => {}} open={false} /></MemoryRouter>);
    rerender(<MemoryRouter><CreateWithAiPanel onClose={() => {}} open /></MemoryRouter>);
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(settle).toBeTypeOf('function'));
    settle!();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(3));
    // The user's own hand-built workflow was in the REOPEN baseline, so the panel
    // does not offer it as something the Architect produced.
    expect(screen.queryByRole('link')).toBeNull();
  });
});
