/**
 * Workflow @-mention convergence onto the backend ownership index (ADR 0163
 * follow-on). The sync picker merges the caller's REAL owned workflows (fetched
 * async into a module cache) with localStorage drafts, deduped by workflowId.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { listWorkflowSummaries as ListSummaries, WorkflowSummaryDTO } from '../../../workflows/workflowsClient.js';
import type { listSavedWorkflows as ListSaved } from '../../../builder/persistence/localStore.js';
import type { SavedWorkflow } from '../../../builder/schema/workflow.js';
import type { WorkflowMentionEntry } from '../workflowMentions.js';

const listWorkflowSummaries = vi.fn<typeof ListSummaries>();
const listSavedWorkflows = vi.fn<typeof ListSaved>();
const demoModeCached = vi.fn<() => boolean>();

vi.mock('../../../workflows/workflowsClient.js', () => ({
  listWorkflowSummaries: (...a: Parameters<typeof ListSummaries>) => listWorkflowSummaries(...a),
}));
vi.mock('../../../builder/persistence/localStore.js', () => ({
  listSavedWorkflows: () => listSavedWorkflows(),
}));
vi.mock('../../../client/demoMode.js', () => ({ demoModeCached: () => demoModeCached() }));
// i18n .t echoes the key so assertions don't depend on locale strings.
vi.mock('../../../i18n/index.js', () => ({ default: { t: (k: string) => k } }));

const TS = '2026-01-01T00:00:00Z';
function summary(workflowId: string, name: string, nodeCount: number): WorkflowSummaryDTO {
  return { workflowId, kind: 'workflow', name, nodeCount, createdAt: TS, updatedAt: TS };
}
function saved(id: string, name: string): SavedWorkflow {
  return {
    id, name, version: '1', edges: [], createdAt: TS, updatedAt: TS,
    nodes: [{ id: 'n1', kind: 'core.noop', name: 'n1', position: { x: 0, y: 0 }, config: {} }],
  };
}

// The backend cache + load-failed flag are MODULE state: every case gets a fresh
// module (the mocks above persist across `resetModules`), so the file passes in
// any order.
let mod: typeof import('../workflowMentions.js');
beforeEach(async () => {
  listWorkflowSummaries.mockReset();
  listSavedWorkflows.mockReset().mockReturnValue([]);
  demoModeCached.mockReset().mockReturnValue(false);
  vi.resetModules();
  mod = await import('../workflowMentions.js');
});

describe('listWorkflowMentions — backend ownership index merge', () => {
  it('starts empty before the cache is warmed (fail-safe: no backend call inline)', async () => {
    listWorkflowSummaries.mockResolvedValue([summary('wf.a', 'Alpha', 3)]);
    expect(mod.listWorkflowMentions()).toHaveLength(0);
    // The sync picker never fetches: not during the call, and not in a
    // fire-and-forget continuation after it.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(listWorkflowSummaries).not.toHaveBeenCalled();
    expect(mod.listWorkflowMentions()).toHaveLength(0);
  });

  it('includes the caller’s owned workflows after a refresh', async () => {
    listWorkflowSummaries.mockResolvedValue([summary('wf.a', 'Alpha', 3)]);
    await mod.refreshWorkflowMentionCache();
    const out = mod.listWorkflowMentions();
    expect(out.map((e) => e.workflowId)).toEqual(['wf.a']);
    expect(out[0]!.slug).toBe('alpha');
  });

  it('dedupes by workflowId — a backend workflow also in localStorage lists once (backend wins)', async () => {
    listWorkflowSummaries.mockResolvedValue([summary('wf.a', 'Alpha', 3)]);
    listSavedWorkflows.mockReturnValue([saved('wf.a', 'Alpha (stale local)')]);
    await mod.refreshWorkflowMentionCache();
    const out = mod.listWorkflowMentions();
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe('Alpha'); // backend name, not the local copy
  });

  it('keeps localStorage-only drafts not covered by the backend index', async () => {
    listWorkflowSummaries.mockResolvedValue([summary('wf.a', 'Alpha', 1)]);
    listSavedWorkflows.mockReturnValue([saved('wf.local', 'Local Draft')]);
    await mod.refreshWorkflowMentionCache();
    expect(mod.listWorkflowMentions().map((e) => e.workflowId).sort()).toEqual(['wf.a', 'wf.local']);
  });

  it('leaves the cache untouched (fail-safe) when the backend errors', async () => {
    listWorkflowSummaries.mockResolvedValue([summary('wf.a', 'Alpha', 1)]);
    await mod.refreshWorkflowMentionCache();
    listWorkflowSummaries.mockRejectedValue(new Error('backend down'));
    await mod.refreshWorkflowMentionCache();
    expect(mod.listWorkflowMentions().map((e) => e.workflowId)).toEqual(['wf.a']); // prior cache survives
  });

  it('ADR 0764 (CHATWF-4) — a failed load is RECORDED, and a later success clears it', async () => {
    listWorkflowSummaries.mockRejectedValue(new Error('429'));
    await mod.refreshWorkflowMentionCache();
    expect(mod.workflowMentionLoadFailed()).toBe(true);
    listWorkflowSummaries.mockResolvedValue([]);
    await mod.refreshWorkflowMentionCache();
    expect(mod.workflowMentionLoadFailed()).toBe(false);
  });
});

describe('detectWorkflowSlashMention — ADR 0764 (CHATWF-2)', () => {
  beforeEach(async () => {
    listWorkflowSummaries.mockResolvedValue([summary('wf.s', 'Summarize', 1)]);
    await mod.refreshWorkflowMentionCache();
  });

  it('matches a bare `/slug args` with no agent', () => {
    const m = mod.detectWorkflowSlashMention('/summarize the doc');
    expect(m?.entry.workflowId).toBe('wf.s');
    expect(m?.trailing).toBe('the doc');
    expect(m?.agentSlug).toBeNull();
  });

  it('matches the `@agent /slug` hand-off the picker builds — the case that used to fall through to plain chat', () => {
    const m = mod.detectWorkflowSlashMention('@devon /summarize the doc');
    expect(m?.entry.workflowId).toBe('wf.s');
    expect(m?.trailing).toBe('the doc');
    expect(m?.agentSlug).toBe('devon');
  });

  it('does not match a slash token mid-sentence', () => {
    expect(mod.detectWorkflowSlashMention('@devon please /summarize')).toBeNull();
  });
});

describe('filterMentions — ADR 0770 D8', () => {
  const entry = (displayName: string, slug: string): WorkflowMentionEntry => ({ workflowId: `wf.${slug}`, displayName, slug, description: '', toolName: `wf_${slug}` });
  it('matches the slug the picker DISPLAYS, not only the display name', () => {
    const rows = [entry('Daily report', 'daily-report'), entry('Weekly digest', 'weekly-digest')];
    // `daily-r` appears nowhere in "Daily report" — it matched nothing before.
    expect(mod.filterMentions(rows, 'daily-r').map((e) => e.slug)).toEqual(['daily-report']);
    expect(mod.filterMentions(rows, 'weekly').map((e) => e.slug)).toEqual(['weekly-digest']);
  });
});
