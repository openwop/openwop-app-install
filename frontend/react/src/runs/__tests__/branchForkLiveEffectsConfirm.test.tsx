/**
 * H81 — `replay.md` §`branch`: a branch fork RE-EXECUTES side-effecting nodes
 * live for sequences `>= fromSeq`, so "branching past an already-executed
 * payment or notification will perform it again. This is by design" — and the
 * same paragraph adds that it "is easy to miss … A host SHOULD surface this in
 * any operator-facing fork UI."
 *
 * Before this, `onForkFrom` called `forkRun(..., { mode: 'branch' })` with no
 * confirmation at all and navigated away immediately: one click re-charged a
 * card, and the surface that could have said so was gone before the operator
 * could read it.
 *
 * The legs are chosen so the guard cannot be satisfied by simply never forking:
 * leg 2 is the positive control. Leg 3 is a NON-VACUITY FLOOR on the copy —
 * a confirm that asks a generic "are you sure" would satisfy legs 1 and 2 while
 * telling the operator nothing they didn't already know, which is the failure
 * this card exists to fix rather than a lesser version of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { messages as streamsEn } from '../../streams/i18n/en.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const confirmFn = vi.hoisted(() => vi.fn());
vi.mock('../../ui/confirm.js', () => ({ confirm: confirmFn, ConfirmRoot: () => null }));

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  pollEvents: vi.fn(),
  forkRun: vi.fn(),
  subscribeToRun: vi.fn(),
}));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRun: api.getRun, pollEvents: api.pollEvents, forkRun: api.forkRun };
});
vi.mock('../../client/streamsClient.js', () => ({ subscribeToRun: api.subscribeToRun }));
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listOpenInterrupts: vi.fn(async () => []) };
});
vi.mock('../../client/feedbackClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listAnnotations: vi.fn(async () => []) };
});
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRunRevision: vi.fn(async () => null) };
});

const { RunDetailPage } = await import('../RunDetailPage.js');

const SNAPSHOT = {
  runId: 'r1', status: 'completed', workflowId: 'wf1',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getRun.mockResolvedValue(SNAPSHOT);
  api.pollEvents.mockResolvedValue({ events: [{ eventId: 'e1', sequence: 1, type: 'node.started', runId: 'r1' }] });
  api.subscribeToRun.mockReturnValue({ close: () => {} });
  api.forkRun.mockResolvedValue({ runId: 'r2', sourceRunId: 'r1' });
});
afterEach(() => cleanup());

async function openRun(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByText('r1');
}

async function clickFork(): Promise<void> {
  // The event LOG view is where the per-event fork control lives; the default
  // view is the timeline. Switch first so the click drives the real control
  // rather than a synthetic call to the handler.
  fireEvent.click(await screen.findByText(en.eventViewLog));
  const btn = await screen.findByTitle(streamsEn.forkTitle);
  fireEvent.click(btn);
}

describe('H81 — a branch fork warns that live effects will run again (replay.md §branch SHOULD)', () => {
  it('declining the confirm does NOT fork', async () => {
    confirmFn.mockResolvedValue(false);
    await openRun();
    await clickFork();
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(api.forkRun).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: accepting DOES fork, in branch mode', async () => {
    // Without this, "never fork" would satisfy the leg above and the button
    // could be broken outright while the guard reported success.
    confirmFn.mockResolvedValue(true);
    await openRun();
    await clickFork();
    await waitFor(() => expect(api.forkRun).toHaveBeenCalled());
    expect(api.forkRun.mock.calls[0]![1]).toMatchObject({ mode: 'branch' });
  });

  it('NON-VACUITY FLOOR: every locale names the re-execution, in all four languages', async () => {
    // A generic "are you sure?" would pass both legs above and still leave the
    // operator exactly as uninformed — which is the defect, not a milder form
    // of it. Each locale must name the thing that happens AGAIN.
    const locales = { en, es, fr, 'pt-BR': ptBR } as unknown as Record<string, Record<string, string>>;
    // Checked against title + body TOGETHER: the consequence may legitimately
    // be named in either, and forcing it into one would be a style rule rather
    // than an honesty one.
    const mustMention = {
      en: [/again|second time/i, /payment/i],
      es: [/de nuevo|nuevamente|segunda vez/i, /pago/i],
      fr: [/nouveau|réexécut|seconde fois/i, /paiement/i],
      'pt-BR': [/de novo|novamente|segunda vez/i, /pagamento/i],
    } as Record<string, RegExp[]>;
    for (const [tag, bundle] of Object.entries(locales)) {
      const body = bundle.forkBranchConfirmBody;
      expect(body, `${tag} is missing forkBranchConfirmBody`).toBeTruthy();
      const copy = `${bundle.forkBranchConfirmTitle ?? ''} ${body ?? ''}`;
      for (const re of mustMention[tag]!) {
        expect(copy, `${tag} copy must name the consequence (${re})`).toMatch(re);
      }
      expect(bundle.forkBranchConfirmTitle, `${tag} title`).toBeTruthy();
      expect(bundle.forkBranchConfirmAction, `${tag} action label`).toBeTruthy();
    }
  });
});
