/**
 * ADR 1040 D7 F1 (Book AI P47) — a feature's own wording on BOTH inline approval
 * cards (the chat card and the run-detail twin), through one shared helper.
 *
 *  - `actionLabels` relabels a listed verb; the click still resolves the
 *    CANONICAL verb (display only).
 *  - `promptKey` localizes the prompt.
 *  - A key that does not exist in a loaded catalog renders the canonical label,
 *    never the raw key.
 *  - `declineExpected` confirms reject without the danger reject copy.
 *  - A LAZY feature namespace (ADR 0490) is loaded by the card, which re-renders
 *    with the wording once it lands (canonical labels until then).
 *  - The /reviews card (and the chat's review strip) shows the same words and the
 *    same confirm for the same gate (`review.gateWording`).
 *
 * Red when: either card stops calling `gateActionLabel` / `gatePrompt` /
 * `gateRejectConfirm` (chat/reviews/gateWording.ts), the helper drops its
 * `i18n.exists` check, or the decline branch keeps `danger: true`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '../../i18n/index.js';

const api = vi.hoisted(() => ({ resolveByRun: vi.fn(), confirm: vi.fn() }));
vi.mock('../../ui/confirm.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, confirm: api.confirm };
});
// The /reviews card's handoff panel has its own tests; it would fetch here.
vi.mock('../../chat/reviews/ReviewHandoff.js', () => ({ ReviewHandoff: () => null }));
vi.mock('../../client/useEffectiveAccess.js', () => ({ useEffectiveAccessState: () => ({ access: {}, resolved: true }), isAdminCaller: () => false }));
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, resolveByRun: api.resolveByRun };
});

const { ApprovalCard } = await import('../ApprovalCard.js');
const { registerDefaultCards } = await import('../../chat/registry/defaultCards.js');
const { getCard } = await import('../../chat/registry/CardRegistry.js');
const { ReviewCard } = await import('../../chat/reviews/ReviewCard.js');
const { MemoryRouter } = await import('react-router-dom');

const DATA = {
  prompt: 'Apply the suggested edits?',
  actions: ['approve', 'reject'],
  actionLabels: { approve: 'adr1040test:useEdits', reject: 'adr1040test:keepMine' },
  promptKey: 'adr1040test:prompt',
  declineExpected: true,
};

beforeAll(() => {
  i18n.addResourceBundle('en', 'adr1040test', { useEdits: 'Use these edits', keepMine: 'Keep my text', prompt: 'Your co-author suggested edits.' });
  registerDefaultCards();
});
beforeEach(() => {
  vi.clearAllMocks();
  api.resolveByRun.mockResolvedValue({});
  api.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

function renderChatCard(data: unknown, onAction = vi.fn(async () => undefined)) {
  const Card = getCard('interrupt.approval')!.Component;
  render(<Card payload={{ kind: 'approval', data }} cardType="interrupt.approval" context={{ runId: 'r-1', nodeId: 'gate', tenantId: 'demo' }} onAction={onAction} autoFocus={false} />);
  return onAction;
}

describe('the run-detail approval card', () => {
  it('shows the feature\'s labels and prompt, and still resolves the canonical verb', async () => {
    render(<ApprovalCard runId="r-1" nodeId="gate" token="t" data={DATA} onResolved={() => {}} />);
    expect(screen.getByText('Your co-author suggested edits.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use these edits' }));
    await waitFor(() => expect(api.resolveByRun).toHaveBeenCalledWith('r-1', 'gate', { action: 'approve', comment: undefined }));
  });

  it('an expected decline confirms without danger, and resolves `reject`', async () => {
    render(<ApprovalCard runId="r-1" nodeId="gate" token="t" data={DATA} onResolved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my text' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalled());
    const arg = api.confirm.mock.calls[0]![0] as { title: string; danger: boolean; confirmLabel: string };
    expect(arg).toMatchObject({ title: 'Decline this?', danger: false, confirmLabel: 'Keep my text' });
    await waitFor(() => expect(api.resolveByRun).toHaveBeenCalledWith('r-1', 'gate', { action: 'reject', comment: undefined }));
  });

  it('a gate without declineExpected keeps the danger confirm', async () => {
    const { declineExpected: _d, ...plain } = DATA;
    render(<ApprovalCard runId="r-1" nodeId="gate" token="t" data={plain} onResolved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my text' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalled());
    expect(api.confirm.mock.calls[0]![0]).toMatchObject({ danger: true, title: 'Reject this request?' });
  });

  it('a label whose catalog text holds markup renders it as TEXT, never HTML', () => {
    i18n.addResourceBundle('en', 'adr1040markup', { evil: '<img src=x onerror=alert(1)>Go' });
    const { container } = render(<ApprovalCard runId="r-1" nodeId="gate" token="t" data={{ ...DATA, actionLabels: { approve: 'adr1040markup:evil' } }} onResolved={() => {}} />);
    expect(screen.getByRole('button', { name: '<img src=x onerror=alert(1)>Go' })).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('a key missing from every catalog falls back to the canonical label, never the raw key', () => {
    render(<ApprovalCard runId="r-1" nodeId="gate" token="t" data={{ ...DATA, actionLabels: { approve: 'adr1040test:nope' }, promptKey: 'adr1040test:alsoNope' }} onResolved={() => {}} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByText('adr1040test:nope')).toBeNull();
    expect(screen.getByText('Apply the suggested edits?')).toBeTruthy();
  });
});

describe('a lazy feature namespace', () => {
  it('is loaded by the card, which then shows the wording', async () => {
    expect(i18n.hasLoadedNamespace('adr1040lazy')).toBe(false);
    const load = vi.spyOn(i18n, 'loadNamespaces').mockImplementation(async (ns) => {
      const list = Array.isArray(ns) ? ns : [ns];
      if (list.includes('adr1040lazy')) i18n.addResourceBundle('en', 'adr1040lazy', { use: 'Use lazily' });
    });
    try {
      renderChatCard({ ...DATA, actionLabels: { approve: 'adr1040lazy:use' }, promptKey: undefined });
      expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy(); // canonical until it lands
      expect(await screen.findByRole('button', { name: 'Use lazily' })).toBeTruthy();
      expect(load).toHaveBeenCalledWith(['adr1040lazy']);
    } finally {
      load.mockRestore();
    }
  });
});

describe('the /reviews card (same helper, same gate)', () => {
  const review = {
    reviewId: 'interrupt:i-1' as const, source: 'interrupt' as const, kind: 'approval', status: 'pending' as const, tenantId: 't',
    runId: 'r-1', nodeId: 'gate', interruptId: 'i-1',
    requestedBy: { kind: 'user' as const, id: 'u-1' }, requestedAt: '2026-11-03T00:00:00Z', summary: 'Apply the suggested edits?',
    actions: [{ action: 'approve' }, { action: 'reject' }], provenanceRefs: [],
    gateWording: { actionLabels: DATA.actionLabels, declineExpected: true },
  };
  it('shows the feature labels and the same gentle confirm, and decides the canonical verb', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><ReviewCard review={review} onDecide={onDecide} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /Use these edits/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Keep my text/ }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalled());
    expect(api.confirm.mock.calls[0]![0]).toMatchObject({ danger: false, title: 'Decline this?', confirmLabel: 'Keep my text' });
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('reject', {}));
  });
});

describe('the chat approval card (same helper)', () => {
  it('shows the feature\'s labels and prompt, and resolves the canonical verb', async () => {
    const onAction = renderChatCard(DATA);
    expect(screen.getByText('Your co-author suggested edits.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use these edits' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('resolve', { action: 'approve', comment: undefined }));
  });

  it('an expected decline confirms without danger', async () => {
    const onAction = renderChatCard(DATA);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my text' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalled());
    expect(api.confirm.mock.calls[0]![0]).toMatchObject({ danger: false, title: 'Decline this?' });
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('resolve', { action: 'reject', comment: undefined }));
  });
});
