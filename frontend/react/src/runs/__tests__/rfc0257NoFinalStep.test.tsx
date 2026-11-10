/**
 * RFC 0257 (ADR 1027 P3) — run detail shows a run that completed without
 * reaching any terminal node as its own state: the status badge reads
 * "Completed: no final step ran" in the warning tone, not the success tone,
 * and a notice names the skipped final steps.
 *
 * The marker comes from the recorded `run.completed` payload in the event log
 * (`skippedTerminals`); the snapshot status stays `completed` because the run
 * did complete. Positive control: a `run.completed` without the marker keeps
 * the plain `completed` badge and no notice.
 *
 * Red when (sabotage-witnessed, ADR 1027 §Witnesses P3): the page ignores the
 * marker, or badges every completed run as "no final step".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';

const api = vi.hoisted(() => ({ getRun: vi.fn(), pollEvents: vi.fn(), subscribeToRun: vi.fn() }));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRun: api.getRun, pollEvents: api.pollEvents };
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
// The `eventReadHonesty.test.tsx` precedent: refuse the SDK discovery read.
vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new Error('no network in unit tests'))));
const { RunDetailPage } = await import('../RunDetailPage.js');

const SNAPSHOT: RunSnapshot = {
  runId: 'r1', status: 'completed', workflowId: 'wf1',
  owner: { tenant: 't1', subject: { issuer: 'urn:openwop:test', subjectId: 'u1', tenant: 't1', lane: 'session', kind: 'user' } },
  eventLogSchemaVersion: 3,
};

function completedEvent(payload: Record<string, unknown>): RunEventDoc {
  return { runId: 'r1', eventId: 'e2', sequence: 2, type: 'run.completed', timestamp: '2026-11-02T00:00:01Z', schemaVersion: 1, payload };
}

function view(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getRun.mockResolvedValue(SNAPSHOT);
  api.subscribeToRun.mockImplementation(() => ({ close: () => {} }));
});
afterEach(() => cleanup());

describe('run detail — a completion with no final step is not a plain success', () => {
  it('the marker → the "no final step" badge in the warning tone, and a notice naming the skipped steps', async () => {
    api.pollEvents.mockResolvedValue({ events: [completedEvent({ outputs: {}, skippedTerminals: ['zeta', 'alpha'] })] });
    view();
    const badge = await screen.findByText('Completed: no final step ran');
    expect(badge.className).toContain('status-badge');
    expect(badge.className).not.toContain('completed');
    expect(badge.className).toContain('waiting-approval');
    expect(screen.getByText(/every final step \(zeta, alpha\) was skipped/)).toBeTruthy();
  });

  it('positive control: run.completed WITHOUT the marker keeps the plain completed badge and no notice', async () => {
    api.pollEvents.mockResolvedValue({ events: [completedEvent({ outputs: { act: { ok: true } } })] });
    view();
    const badge = await screen.findByText('completed', { selector: '.status-badge' });
    expect(badge.className).toContain('completed');
    expect(screen.queryByText('Completed: no final step ran')).toBeNull();
    expect(screen.queryByText(/was skipped by its conditions/)).toBeNull();
  });
});
