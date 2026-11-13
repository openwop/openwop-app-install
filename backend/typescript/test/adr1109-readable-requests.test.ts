/**
 * ADR 1109 P1 — a request a person can read (#5793 part 1).
 *
 * A customer saw `wf.copy.cv-decision-reminders.4b50… needs your input` in
 * `/inbox`. Three causes, each pinned here:
 *  - D1: `core.chat.approvalGate` put its `title` on the chat card only and left
 *    `title`/`prompt` out of `ctx.suspend`, so `interrupt.data` had no words;
 *  - D2: the notification read only `prompt`/`summary`, and never the title;
 *  - D3: the label was `workflowName || workflowId`, never the chain's own name.
 * And D4: a request now names the project a project schedule fired it for.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import {
  catalogWorkflowNameResolver,
  emitInterruptNotification,
  requestWordsOf,
  runSubjectOf,
  setNotificationWorkflowNameResolver,
} from '../src/notifications/notify.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

type GateCtx = Record<string, unknown>;
const { approvalGate } = (await import(
  /* @vite-ignore */ new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href
)) as {
  approvalGate: (ctx: GateCtx) => Promise<unknown>;
};

/** Run the gate once and return what it handed `ctx.suspend`. */
async function suspendPayloadOf(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  await approvalGate({
    runId: 'r-1',
    nodeId: 'gate',
    config,
    inputs: {},
    variables: { get: () => undefined, set: () => undefined },
    suspend: async (p: Record<string, unknown>) => { captured = p; return { action: 'accept' }; },
  });
  if (!captured) throw new Error('the gate never suspended');
  return captured;
}

describe('D1 — the approval gate forwards its own words', () => {
  it('puts title and prompt on the suspend payload', async () => {
    const p = await suspendPayloadOf({ title: 'Approve the launch brief', prompt: 'Check the tone before it goes out.', actions: ['approve', 'reject'] });
    expect(p.title).toBe('Approve the launch brief');
    expect(p.prompt).toBe('Check the tone before it goes out.');
  });

  it('drops blank and non-string words rather than forwarding them', async () => {
    const p = await suspendPayloadOf({ title: '   ', prompt: 42 });
    expect('title' in p).toBe(false);
    expect('prompt' in p).toBe(false);
  });
});

describe('D2 — one reader for what a request says', () => {
  it('reads prompt, then description, then summary, with the title apart', () => {
    expect(requestWordsOf({ title: 'T', prompt: 'P', description: 'D', summary: 'S' })).toEqual({ title: 'T', text: 'P' });
    expect(requestWordsOf({ description: 'D', summary: 'S' })).toEqual({ text: 'D' });
    expect(requestWordsOf({ summary: 'S' })).toEqual({ text: 'S' });
    expect(requestWordsOf({ title: ' ', prompt: '' })).toEqual({});
    expect(requestWordsOf(null)).toEqual({});
    expect(requestWordsOf(['P'])).toEqual({});
  });
});

describe('D4 — what a request is about', () => {
  it('names a project only from a project schedule\'s host-written owner', () => {
    expect(runSubjectOf({ metadata: { schedule: { ownerScope: 'project:p-kitchen' } } })).toEqual({ kind: 'project', id: 'p-kitchen' });
    expect(runSubjectOf({ metadata: { schedule: { ownerScope: 'user:u-1' } } })).toBeUndefined();
    expect(runSubjectOf({ metadata: { schedule: { ownerScope: 'project:' } } })).toBeUndefined();
    // A client-shaped hint is not a source: only `schedule.ownerScope` is read.
    expect(runSubjectOf({ metadata: { manual: { source: 'project' }, projectId: 'p-forged' } })).toBeUndefined();
  });
});

describe('the notification a customer sees (D2, D3, D4 together)', () => {
  afterEach(() => setNotificationWorkflowNameResolver(null));

  const now = new Date().toISOString();
  const run = (runId: string, tenantId: string, metadata: Record<string, unknown>): RunRecord => ({
    runId, tenantId, workflowId: 'wf.copy.cv-decision-reminders.4b50', status: 'running',
    inputs: null, metadata, configurable: {}, createdAt: now, updatedAt: now,
  });
  const interrupt = (runId: string, data: unknown): InterruptRecord => ({
    interruptId: `int-${runId}`, runId, nodeId: 'gate', kind: 'approval', token: 'tok', data, createdAt: now,
  });

  async function emitted(r: RunRecord, data: unknown) {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    await storage.insertRun(r);
    await emitInterruptNotification(storage, interrupt(r.runId, data));
    const list = await storage.listNotifications({ tenantId: r.tenantId });
    await storage.close();
    expect(list.length).toBe(1);
    return list[0]!;
  }

  it('reads as the gate\'s words under the chain\'s name, about its project', async () => {
    setNotificationWorkflowNameResolver(async () => 'Decision reminders');
    const n = await emitted(
      run('r-read', 't-read', { schedule: { ownerScope: 'project:p-kitchen' } }),
      { title: 'Approve the launch brief', prompt: 'Check the tone before it goes out.' },
    );
    expect(n.title).toBe('Approve the launch brief');
    expect(n.message).toBe('Decision reminders — Check the tone before it goes out.');
    expect(n.metadata?.subject).toEqual({ kind: 'project', id: 'p-kitchen' });
  });

  it('a dispatcher-stamped workflowName still wins over the definition', async () => {
    setNotificationWorkflowNameResolver(async () => 'Decision reminders');
    const n = await emitted(run('r-stamp', 't-stamp', { workflowName: 'Weekly check-in' }), null);
    expect(n.message).toBe('Weekly check-in needs your input');
    expect(n.title).toBe('Approval needed');
    expect(n.metadata?.subject).toBeUndefined();
  });

  it('a failed name lookup falls back to the id and still notifies', async () => {
    setNotificationWorkflowNameResolver(async () => { throw new Error('catalog down'); });
    const n = await emitted(run('r-fail', 't-fail', {}), { prompt: 'Sign off the invoice' });
    expect(n.message).toBe('wf.copy.cv-decision-reminders.4b50 — Sign off the invoice');
  });

  // casavoga-prod: "wf.copy.cv-lead-intake.969031f3… needs your input". The real
  // boot resolver, not a stub: a tenant's copy carries the name chainInstantiation
  // stamped on its definition, and an unknown id leaves the id.
  it('the boot resolver names a tenant-owned copy by its stamped name', async () => {
    const copyId = 'wf.copy.cv-decision-reminders.4b50';
    const catalog = {
      getWorkflow: async (id: string) => id === copyId
        ? { workflowId: id, definition: { workflowId: id, metadata: { name: 'CV decision reminders' }, nodes: [], edges: [] } as never }
        : null,
    };
    setNotificationWorkflowNameResolver(catalogWorkflowNameResolver(catalog));
    const named = await emitted(run('r-copy', 't-copy', {}), null);
    expect(named.message).toBe('CV decision reminders needs your input');
    const unknown = await emitted({ ...run('r-gone', 't-copy', {}), workflowId: 'wf.copy.deleted.0000' }, null);
    expect(unknown.message).toBe('wf.copy.deleted.0000 needs your input');
  });
});
