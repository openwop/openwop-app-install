/**
 * ADR 0524 §1 — running a workflow must not overwrite the server head with a
 * stale localStorage copy, and must FAIL CLOSED when it cannot tell.
 *
 * The runs index and the chat `/workflow` mention register-then-run by
 * serializing a `SavedWorkflow` read from localStorage. A record written by a
 * pre-ADR-0523 bundle carries no node `inputs`, and the CORRECTED serializer
 * then faithfully emits the nothing that is there — so pressing Run re-strips
 * the head. A refresh does not help: the staleness is in browser storage, not in
 * the JS bundle, so a workflow the user only ever RUNS is never healed.
 *
 * TWO LANES, TWO INSTRUMENTS (w49 grade pass, GUARD-CODE-3):
 *
 *  - THE RUNS INDEX is now BEHAVIOURAL: the real `RunsIndexPage` is rendered,
 *    the saved workflow is submitted through the real form, and the register
 *    client is a mock whose calls are the observable. The source-shape cases
 *    this replaced stayed green when `probe = null;` was inserted after the
 *    fetch (every Run then overwrote the head) — they policed a spelling.
 *  - THE CHAT MENTION stays a SOURCE-SHAPE check — an honest CEILING, not a
 *    claim of behavioural coverage. `useWorkflowRunMentions` needs a full
 *    `ChatSessionCore` (session state, five refs, SSE subscription plumbing)
 *    plus the backend store, run-input contract and BYOK reads before it reaches
 *    the register, so it cannot be driven here without rebuilding the chat
 *    session. Those three cases still cannot see a semantic bypass that keeps
 *    the spelling; GUARD-CODE-3 stays open for that lane only.
 *
 * What turns it red: registering without probing; registering when the probe
 * returned a head; registering when the probe threw (fail-open).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { SavedWorkflow } from '../../builder/schema/workflow.js';
import type { BackendWorkflowDefinition } from '../../builder/schema/serialize.js';

const SAVED: SavedWorkflow = {
  id: 'wf_local', name: 'Local copy', version: '1', nodes: [], edges: [],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

const reg = vi.hoisted(() => ({
  fetchRegisteredWorkflow: vi.fn<(workflowId: string) => Promise<unknown | null>>(),
  registerWorkflow: vi.fn<(body: unknown) => Promise<{ workflowId: string; nodeCount: number }>>(),
  createRun: vi.fn<(req: unknown) => Promise<{ runId: string }>>(),
}));
vi.mock('../../builder/persistence/registerClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, fetchRegisteredWorkflow: reg.fetchRegisteredWorkflow, registerWorkflow: reg.registerWorkflow };
});
vi.mock('../../builder/persistence/localStore.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listSavedWorkflows: () => [SAVED] };
});
vi.mock('../../builder/schema/serialize.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  // The serializer's own correctness is not this file's claim; the register
  // receiving SOMETHING is. A fixed, typed definition keeps it out of the way.
  const def = (wf: SavedWorkflow): BackendWorkflowDefinition => ({ workflowId: wf.id, nodes: [], edges: [] });
  return { ...orig, serializeWorkflow: def };
});
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, createRun: reg.createRun, listMyRuns: vi.fn(async () => []) };
});
vi.mock('../../client/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  // No inputSchema → the plain textarea, whose '{}' is a valid payload.
  return { ...orig, getWorkflowDefinitionRaw: vi.fn(async () => null) };
});
// ADR 0661 — refuse every other read (discovery, demo-mode, capabilities) deterministically.
vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new Error('no network in unit tests'))));

const { RunsIndexPage } = await import('../RunsIndexPage.js');

function submitSavedWorkflow(): void {
  render(
    <MemoryRouter initialEntries={['/runs']}>
      <Routes>
        <Route path="/runs" element={<RunsIndexPage />} />
        <Route path="/runs/:runId" element={<p>run page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function pressCreate(): Promise<void> {
  // The saved workflow is the only option, so it is selected once options resolve.
  await screen.findByRole('option', { name: /Local copy/ });
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveProperty('value', 'wf_local'));
  fireEvent.click(screen.getByRole('button', { name: 'Create run' }));
}

const read = (rel: string): string =>
  readFileSync(join(import.meta.dirname, '..', '..', rel), 'utf8');
const CHAT_LANE = 'chat/hooks/chatSession/useWorkflowRunMentions.ts';

beforeEach(() => {
  vi.clearAllMocks();
  reg.registerWorkflow.mockResolvedValue({ workflowId: 'wf_local', nodeCount: 0 });
  reg.createRun.mockResolvedValue({ runId: 'run-new-1234' });
});
afterEach(() => cleanup());

describe('both run-dispatch lanes guard the register', () => {
  it('fixture guard: the chat lane source (the source-checked ceiling lane) is readable and non-trivial', () => {
    // Without this a path typo yields '' and every chat assertion below passes
    // vacuously — the failure mode this whole ADR family keeps hitting.
    expect(read(CHAT_LANE).length, 'chat lane: source unreadable or empty').toBeGreaterThan(2000);
  });

  // ── the runs index: behavioural ──────────────────────────────────────────
  it('the runs index probes the backend before registering (head absent → register, then run)', async () => {
    reg.fetchRegisteredWorkflow.mockResolvedValue(null);
    submitSavedWorkflow();
    await pressCreate();
    await waitFor(() => expect(reg.createRun).toHaveBeenCalledTimes(1));
    expect(reg.fetchRegisteredWorkflow).toHaveBeenCalledWith('wf_local');
    // Positive control: with NO head the register must run — and after the probe.
    expect(reg.registerWorkflow).toHaveBeenCalledTimes(1);
    expect(reg.fetchRegisteredWorkflow.mock.invocationCallOrder[0]!)
      .toBeLessThan(reg.registerWorkflow.mock.invocationCallOrder[0]!);
  });

  it('the runs index registers ONLY when the probe says the head is absent (a live head is never overwritten)', async () => {
    reg.fetchRegisteredWorkflow.mockResolvedValue({ workflowId: 'wf_local', nodes: [{ id: 'n1' }] });
    submitSavedWorkflow();
    await pressCreate();
    // The run still dispatches — only the destructive register is skipped.
    await waitFor(() => expect(reg.createRun).toHaveBeenCalledTimes(1));
    expect(reg.fetchRegisteredWorkflow).toHaveBeenCalledWith('wf_local');
    expect(reg.registerWorkflow).not.toHaveBeenCalled();
  });

  it('the runs index FAILS CLOSED — a probe error must not reach the register', async () => {
    // A 429 / 5xx / offline on the probe: unknown is NOT "absent".
    reg.fetchRegisteredWorkflow.mockRejectedValue(new Error('429 Too Many Requests'));
    submitSavedWorkflow();
    await pressCreate();
    await waitFor(() => expect(reg.createRun).toHaveBeenCalledTimes(1));
    expect(reg.registerWorkflow).not.toHaveBeenCalled();
  });

  // ── the chat mention: source-shape CEILING (see header) ──────────────────
  it('the chat @workflow mention probes the backend before registering (source check — ceiling)', () => {
    expect(read(CHAT_LANE)).toContain('fetchRegisteredWorkflow');
  });

  it('the chat @workflow mention registers ONLY when the probe says the head is absent (source check — ceiling)', () => {
    // The property whose loss is silent: without the guard, a stale local copy
    // overwrites a live head on every Run.
    expect(read(CHAT_LANE)).toMatch(/if \(!probe && !probeFailed\)/);
  });

  it('the chat @workflow mention FAILS CLOSED — a probe error must not reach the register (source check — ceiling)', () => {
    const src = read(CHAT_LANE);
    // `.catch(() => null)` here would fall through to the destructive branch on
    // a 429/5xx/offline — and the per-IP read budget makes 429 a real source on
    // fan-out pages. The catch must set a flag that SUPPRESSES the register.
    expect(src, 'a swallowed probe error must not fall through to the register').not.toMatch(
      /fetchRegisteredWorkflow\([^)]*\)\.catch/,
    );
    expect(src).toMatch(/catch \{ probeFailed = true; \}/);
  });
});
