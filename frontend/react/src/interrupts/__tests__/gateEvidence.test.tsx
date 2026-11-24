/**
 * ADR 0600 §2 (`ISU-10`) — the approval card the app ROUTES TO rendered no
 * evidence.
 *
 * Two cards, one payload, different behaviour: the chat card auto-loaded the
 * gate-preview artifact; `interrupts/ApprovalCard` read `data.prompt` and
 * `data.actions` and nothing else. The interrupt notification's `actionUrl` is
 * `/inbox`, and `/inbox` renders the blind one — so "Confirm the variance
 * figures before surfacing." arrived with no figures, and the approver's only
 * real choices were approve blind or reject blind.
 *
 * The evidence was on the wire the whole time: `executor.ts` binds
 * `artifactId`/`revisionId` onto the interrupt and `listOpenInterrupts` returns
 * them verbatim.
 *
 * w51 r2: "View full" now asserts the modal shows the SAME asset; the options case
 * asserts the second option is acknowledged read-only (the old "no picker" line
 * could not fail — this card never had one); the cancelled-confirm cases drain
 * before asserting nothing was sent; a confirmed reject asserts the full payload.
 *
 * w118 (detection-only, 18 → 18 cases): every assertion that used to red only by a
 * lookup timing out now settles on a state both the real and the broken code render
 * and then reds on a VALUE — the read-only options case pins the card's exact button
 * set (so the "no picker" claim can fail), absence checks run after the evidence read
 * settles and before the positive check, the empty/unrenderable copy is exact, and a
 * cancelled confirm waits for EITHER the confirm or a send before asserting which one
 * happened. Sabotage ids `w118g4-ge-*`.
 *
 * TST-OAN-2 (2026-11-22, user decision): the `/^pick$/` absence line is gone; the
 * exact button list is the failable form of the same claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t } from 'i18next';
// ADR 1031 P2 — a fixture typed renderer (it was a product's outline type).
import { TEST_OUTLINE_TYPE } from '../../chat/reviews/__tests__/testOutlineRenderer.js';
import { render, cleanup, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { CardRegistration } from '../../chat/registry/types.js';
import { announce, currentAnnouncements } from '../../ui/announce.js';

const art = vi.hoisted(() => ({ getArtifact: vi.fn(), getArtifactRevision: vi.fn() }));
const api = vi.hoisted(() => ({ resolveByRun: vi.fn(), confirm: vi.fn() }));
vi.mock('../../ui/confirm.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, confirm: api.confirm };
});
vi.mock('../../chat/artifacts/artifactClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getArtifact: art.getArtifact, getArtifactRevision: art.getArtifactRevision };
});
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, resolveByRun: api.resolveByRun };
});

const { ApprovalCard } = await import('../ApprovalCard.js');

const GATE_PROMPT = 'Confirm the variance figures before surfacing.';

function expectGenericRejectConfirmation(): void {
  const call = api.confirm.mock.calls[0];
  if (!call) throw new Error('Reject confirmation was not shown');
  expect(call[0]).toMatchObject({
    title: t('interrupts:rejectConfirmTitle'), body: t('interrupts:rejectConfirmBody'),
    danger: true, confirmLabel: t('interrupts:actionReject'),
  });
  expect(call[0].title).toBe('Reject this request?');
  expect(call[0].body).toBe('What happens next depends on the workflow; rejection can end the run. Work already done is not undone.');
}

/** The inbox card's evidence block once its artifact read has settled (the
 *  "Loading preview…" line is gone). Rendered on success AND failure. */
async function settledEvidence(): Promise<HTMLElement> {
  await waitFor(() => expect(art.getArtifactRevision).toHaveBeenCalledTimes(1));
  const block = screen.getByTestId('gate-evidence');
  await waitFor(() => expect(within(block).queryByText('Loading preview…')).toBeNull());
  return block;
}

/** Wait until a reject click produced EITHER a confirm or a send, so a missing
 *  confirm reds on the call counts below rather than on a wait that expires. */
async function firstDecision(sent: { mock: { calls: unknown[] } }): Promise<void> {
  await waitFor(() => expect(api.confirm.mock.calls.length + sent.mock.calls.length).toBeGreaterThan(0));
}

function view(data: unknown): void {
  render(
    <ApprovalCard runId="r-1" nodeId="redteam" token="tok" data={data} onResolved={() => {}} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The announcer is module-global; an empty message resets both channels.
  announce('', { assertive: true });
  announce('');
  art.getArtifact.mockResolvedValue({ source: 'text', artifactTypeId: undefined });
  art.getArtifactRevision.mockResolvedValue({ content: 'labor variance -18.4% vs plan' });
  api.resolveByRun.mockResolvedValue({});
  api.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe('inbox / runs ApprovalCard — the approver sees what they are approving', () => {
  it('renders the gate-preview ARTIFACT the interrupt carries (was: nothing)', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    expect(await screen.findByText(/labor variance -18\.4% vs plan/)).toBeTruthy();
    expect(art.getArtifactRevision).toHaveBeenCalledWith('a-1', 'rev-1');
  });

  it('renders inline string OPTIONS as read-only evidence', async () => {
    view({
      prompt: GATE_PROMPT,
      options: [
        { key: 'a', label: 'Draft', content: 'Happy 10th anniversary, A. Person.' },
        { key: 'b', label: 'Alt', content: 'Second variant.' },
      ],
    });
    expect(await screen.findByText(/Happy 10th anniversary/)).toBeTruthy();
    expect(document.querySelector('.approval-preview-body')?.getAttribute('tabindex')).toBe('0');
    // …and the second option is acknowledged as read-only evidence ("+1 more"),
    // not offered as a picker: this card resolves with {action, comment} and
    // cannot carry a chosen resume value.
    expect(screen.getByText(/more items? under review/).textContent).toBe('+1 more item under review.');
    // The card's exact controls: View full + the five verbs, and no picker beside them.
    // (TST-OAN-2, user decision 2026-11-22: this list carries the no-picker claim; the
    // old `/^pick$/` absence line could not fail and was removed.)
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['View full', 'Approve', 'Reject', 'Request changes', 'Defer', 'Escalate']);
  });

  it('a FAILED evidence read refuses to read as "no preview available"', async () => {
    art.getArtifactRevision.mockRejectedValue(new Error('boom'));
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    const block = await settledEvidence();
    expect(within(block).queryByText(/No preview available/i)).toBeNull(); // settled first, so this can fail
    const failed = screen.getByTestId('gate-evidence-failed');
    expect(failed.textContent).toMatch(/couldn’t load/i);
  });

  it('…and it ANNOUNCES, from the one region this app trusts', async () => {
    // ADR 0600 §Correction 7. This shipped as a hand-rolled `<p role="alert">` —
    // a conditionally mounted inline region arriving with its text inside, the
    // exact mechanism §3 removes from `CompletionShell` and `ui/Notice.tsx`
    // refuses to treat as established. It carried this PR's most consequential
    // sentence ("Don't decide from this card") and no test asserted it spoke;
    // all four a11y gates are blind to the shape (§3's measured table).
    art.getArtifactRevision.mockRejectedValue(new Error('boom'));
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    await screen.findByTestId('gate-evidence-failed');
    await act(async () => {}); // the Notice's announce effect has run; read the value, do not wait for it
    expect(currentAnnouncements().assertive).toMatch(/Don’t decide from this card/i);
  });

  it('a SUCCESSFUL evidence read announces NOTHING (the polarity — no double-announce)', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    await settledEvidence();
    // Flush passive effects first: a negative read right after the settle would pass before a late announcement lands.
    await act(async () => {});
    expect(currentAnnouncements().assertive).toBe('');
    expect(await screen.findByText(/labor variance -18\.4% vs plan/)).toBeTruthy();
    await act(async () => {});
    expect(currentAnnouncements().assertive).toBe(''); // still nothing once the content is up
  });

  it('a gate that captured NOTHING says so — a blind card announces it is blind', async () => {
    // The replay/fork lane: `executor.ts` skips artifact persistence when
    // `run.forkMode === 'replay'`, so there is genuinely nothing to show.
    view({ prompt: GATE_PROMPT });
    const none = await screen.findByTestId('gate-evidence-none');
    expect(none.textContent).toMatch(/Nothing was captured/i);
    expect(none.textContent).toBe('Nothing was captured for this gate, so there is no preview of what you’re approving. Open the run before deciding.');
  });

  it('an UNRECOGNIZED payload does not become "nothing was captured"', async () => {
    // `core.interrupt` forwards `config.data` VERBATIM, so a pack author can put
    // an arbitrary payload on an approval interrupt. The card cannot render it —
    // and "this card can't show it" is a different statement from "the gate
    // captured nothing", which is a claim about the RUN.
    view({ prompt: GATE_PROMPT, quarterlyFigures: { labor: -18.4 } });
    const none = await screen.findByTestId('gate-evidence-none');
    expect(none.textContent).not.toMatch(/Nothing was captured/i);
    expect(none.textContent).toMatch(/can’t display/i);
    expect(none.textContent).toBe('This gate carries something this card can’t display. Open the run to see what you’re approving before deciding.');
  });

  it('a SEND gate renders the envelope about to leave, and makes no "nothing captured" claim', async () => {
    view({
      prompt: 'Send this email as you via Gmail?',
      profile: 'openwop-send-approval',
      actions: ['approve', 'reject'],
      message: {
        to: ['a.person@example.com'],
        subject: 'Happy 10th anniversary',
        bodyPreview: 'Congratulations on ten years, A. Person.',
        provider: 'Gmail',
      },
    });
    await screen.findByTestId('gate-evidence'); // rendered whatever the envelope reads as
    expect(screen.queryByTestId('gate-evidence-none')).toBeNull();
    expect(screen.getByText(/a\.person@example\.com/)).toBeTruthy();
    expect(screen.getByText(/Happy 10th anniversary/)).toBeTruthy();
    expect(screen.getByText(/Congratulations on ten years/)).toBeTruthy();
    const send = screen.getByTestId('gate-evidence-send');
    expect(send.textContent).toContain('a.person@example.com');
    expect(send.textContent).toContain('Happy 10th anniversary');
    expect(send.textContent).toContain('Congratulations on ten years, A. Person.');
  });

  it('the prompt and the actions still render (the fix did not displace them)', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    expect(await screen.findByText(GATE_PROMPT)).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^(Approve|Reject|Request changes|Defer|Escalate)$/ }).map((b) => b.textContent?.trim()))
      .toEqual(['Approve', 'Reject', 'Request changes', 'Defer', 'Escalate']);
  });

  it('"View full" opens the modal over the same asset', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /view full/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/labor variance -18\.4% vs plan/)).toBeTruthy(); // the SAME asset
  });
});

/**
 * P9 (2026-10-28) — the Challenge Factory outline gate rendered a raw `{ … }`:
 * its plan was saved UNTYPED (a stale schema copy), so no typed renderer ran
 * and the JSON fell through to Markdown. A saved envelope whose payload has the
 * plan's shape now reads as the outline, inline AND in "View full", from the
 * same pinned revision.
 */
describe('ApprovalCard — a saved untyped plan envelope is readable (P9)', () => {
  const plan = {
    title: 'Twenty-One Days of Focus', promise: 'Focus daily.', audience: 'Makers', durationDays: 21, dailyMinutesBudget: 20,
    outcomes: [], achievements: [],
    days: [{ day: 1, stableActivityId: 'd1', title: 'First block', actionInstruction: 'Focus for 10 minutes.', userFacingWhy: '', estimatedMinutes: 10, achievementIds: [], evidencePolicy: 'note', claimRefs: [],
      alternatives: [{ stableActivityId: 'd1-alt', title: 'Walk instead', actionInstruction: 'Walk for 10 minutes.', evidencePolicy: 'note' }] }],
  };
  beforeEach(() => {
    art.getArtifact.mockResolvedValue({ source: 'run-event', format: 'application/json' }); // no artifactTypeId: untyped
    art.getArtifactRevision.mockResolvedValue({ content: JSON.stringify({ plan, artifact: { artifactTypeId: TEST_OUTLINE_TYPE, title: plan.title, payload: plan } }, null, 2) });
  });

  it('inline and full both show the outline, never the JSON', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'run-event:r-1:outline-approve', revisionId: 'r-1:outline-approve:1' });
    expect(await screen.findByText('Day 1: First block')).toBeTruthy();
    expect(screen.queryByText(/^\{$/)).toBeNull();
    expect(art.getArtifactRevision).toHaveBeenCalledWith('run-event:r-1:outline-approve', 'r-1:outline-approve:1'); // revision binding kept
    fireEvent.click(screen.getByRole('button', { name: /view full/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Day 1: First block')).toBeTruthy();
  });
});

/**
 * ADR 0600 §Correction 1 — §2 claimed ONE shared component and shipped two: the
 * chat card kept a private copy of the ADR 0193 send-approval envelope, which is
 * why the inbox card could say "nothing was captured" over it. The envelope now
 * lives in `GateEvidence`; this asserts the CHAT card did not lose it in the
 * move, through the registry the app actually resolves the card from.
 */
describe('chat ApprovalCard — the send envelope survives the unification', () => {
  async function chatApprovalCard(): Promise<CardRegistration['Component']> {
    const { registerDefaultCards } = await import('../../chat/registry/defaultCards.js');
    const { getCard } = await import('../../chat/registry/CardRegistry.js');
    registerDefaultCards();
    const reg = getCard('interrupt.approval');
    expect(reg).toBeTruthy();
    return reg!.Component;
  }

  it('still renders the exact bytes about to be sent, from the shared component', async () => {
    const Card = await chatApprovalCard();
    render(
      <Card
        cardType="interrupt.approval"
        payload={{
          data: {
            prompt: 'Send this email as you via Gmail?',
            profile: 'openwop-send-approval',
            actions: ['approve', 'reject'],
            message: {
              to: ['a.person@example.com'],
              subject: 'Happy 10th anniversary',
              bodyPreview: 'Congratulations on ten years, A. Person.',
              provider: 'Gmail',
            },
          },
        }}
        onAction={async () => {}}
        isLoading={false}
        context={{ tenantId: 't-1', runId: 'r-1', nodeId: 'send' }}
      />,
    );
    const block = await screen.findByTestId('gate-evidence-send');
    expect(block.textContent).toMatch(/a\.person@example\.com/);
    expect(block.textContent).toMatch(/Congratulations on ten years/);
    expect(screen.getByText('Gmail')).toBeTruthy();
  });

  /**
   * ADR 0600 §Correction 5 / rejection-copy correction — both surfaces
   * confirm the decision; workflow rejection routing owns the run outcome.
   */
  it('a REJECT on the CHAT card asks first too, and a cancelled confirm sends nothing', async () => {
    api.confirm.mockResolvedValue(false);
    const onAction = vi.fn(async () => {});
    const Card = await chatApprovalCard();
    render(
      <Card
        cardType="interrupt.approval"
        payload={{ data: { prompt: 'Review the recognition draft.', actions: ['approve', 'reject'] } }}
        onAction={onAction}
        isLoading={false}
        context={{ tenantId: 't-1', runId: 'r-1', nodeId: 'approve' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await firstDecision(onAction);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expectGenericRejectConfirmation();
    await act(async () => {}); // let the declined confirm settle
    expect(onAction).not.toHaveBeenCalled();
  });

  it('a confirmed CHAT rejection keeps its existing payload without predicting a terminal run outcome', async () => {
    const onAction = vi.fn(async () => {});
    const Card = await chatApprovalCard();
    render(<Card cardType="interrupt.approval" payload={{ data: { prompt: GATE_PROMPT, actions: ['approve', 'reject'] } }}
      onAction={onAction} isLoading={false} context={{ tenantId: 't-1', runId: 'r-1', nodeId: 'approve' }} />);
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expectGenericRejectConfirmation();
    expect(onAction).toHaveBeenCalledWith('resolve', { action: 'reject', comment: undefined });
  });

  it('APPROVE on the CHAT card is deliberately NOT gated (the same polarity §7 asserted)', async () => {
    const onAction = vi.fn(async () => {});
    const Card = await chatApprovalCard();
    render(
      <Card
        cardType="interrupt.approval"
        payload={{ data: { prompt: 'Review the recognition draft.', actions: ['approve', 'reject'] } }}
        onAction={onAction}
        isLoading={false}
        context={{ tenantId: 't-1', runId: 'r-1', nodeId: 'approve' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(api.confirm).not.toHaveBeenCalled();
  });
});

/**
 * ADR 0600 §7 (`ISU-12`) — REJECT was one unconfirmed click straight to the
 * network. Confirm the decision without promising that every workflow fails.
 * Existing payload and approve-without-confirm controls remain.
 */
describe('inbox / runs ApprovalCard — reject confirms, approve does not', () => {
  it('a REJECT asks first, and a cancelled confirm sends nothing', async () => {
    api.confirm.mockResolvedValue(false);
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await firstDecision(api.resolveByRun);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expectGenericRejectConfirmation();
    await act(async () => {}); // let the declined confirm settle
    expect(api.resolveByRun).not.toHaveBeenCalled();
  });

  it('a CONFIRMED reject goes through', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(api.resolveByRun).toHaveBeenCalled());
    expectGenericRejectConfirmation();
    expect(api.resolveByRun).toHaveBeenCalledTimes(1);
    expect(api.resolveByRun).toHaveBeenCalledWith('r-1', 'redteam', { action: 'reject', comment: undefined });
  });

  it('APPROVE is deliberately NOT gated — friction on the common path teaches people to click through', async () => {
    view({ prompt: GATE_PROMPT, artifactId: 'a-1', revisionId: 'rev-1' });
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(api.resolveByRun).toHaveBeenCalled());
    expect(api.confirm).not.toHaveBeenCalled();
  });
});
