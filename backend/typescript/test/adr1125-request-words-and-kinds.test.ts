/**
 * ADR 1125 P1 (#5922) — a request a person can read, from a kind the inbox can answer.
 *
 * D1: every interrupt kind either never notifies or has a card in the SPA's
 *     `RenderInterrupt`. A new kind must choose; it cannot slip into the inbox as
 *     "This app can't answer this kind of step".
 * D2: with no words from the gate, the host composes the title and message, and
 *     neither carries a workflow id or an engine word. An unknown workflow name is
 *     "an automation", never the id.
 * D5: `reason` is host-composed: `named` for an addressed approver, `role` for a
 *     role-addressed request, absent for a broadcast.
 *
 * Sabotage witnesses: drop `'credential'` from RenderInterrupt's cases, or
 * `'external-event'` from NEVER_NOTIFY_KINDS, and the ratchet fails; restore the
 * `run.workflowId` fallback in `workflowNameOf` and the words case fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The named-approver lane also mails; this test reads the inbox row only.
vi.mock('../src/host/emailApprovalDelivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/host/emailApprovalDelivery.js')>()),
  deliverApprovalEmail: async () => {},
}));
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { emitInterruptNotification, setNotificationWorkflowNameResolver } from '../src/notifications/notify.js';
import { NEVER_NOTIFY_KINDS } from '../src/executor/suspendManager.js';
import { PROJECTED_HOST_KINDS } from '../src/executor/interruptRequestedPayload.js';
import type { InterruptRecord, NotificationRecord, RunRecord } from '../src/types.js';

const RENDER_INTERRUPT = fileURLToPath(new URL('../../../frontend/react/src/interrupts/RenderInterrupt.tsx', import.meta.url));

describe('D1 — only answerable kinds notify', () => {
  const rendered = new Set([...readFileSync(RENDER_INTERRUPT, 'utf8').matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!));

  it('reads a real kind list and a real renderer', () => {
    expect(PROJECTED_HOST_KINDS.length).toBeGreaterThanOrEqual(10);
    expect(rendered.has('approval')).toBe(true);
  });

  it('every kind is never-notify or has a card', () => {
    const orphans = PROJECTED_HOST_KINDS.filter((k) => !NEVER_NOTIFY_KINDS.has(k) && !rendered.has(k));
    expect(orphans).toEqual([]);
  });

  it('machine waits and idle chats never notify; credential has a card', () => {
    expect(NEVER_NOTIFY_KINDS.has('external-event')).toBe(true);
    expect(NEVER_NOTIFY_KINDS.has('conversation')).toBe(true);
    expect(NEVER_NOTIFY_KINDS.has('credential')).toBe(false);
    expect(rendered.has('credential')).toBe(true);
  });
});

const now = new Date().toISOString();
const WORKFLOW_ID = 'wf.copy.cv-decision-reminders.4b50';

function run(tenantId: string, metadata: Record<string, unknown> = {}): RunRecord {
  return { runId: `r-${Math.random().toString(36).slice(2)}`, tenantId, workflowId: WORKFLOW_ID, status: 'running', inputs: null, metadata, configurable: {}, createdAt: now, updatedAt: now };
}

async function emitted(r: RunRecord, kind: InterruptRecord['kind'], data: unknown): Promise<readonly NotificationRecord[]> {
  const storage = openSqliteStorage(':memory:');
  ensureNotificationEmitterInstalled(storage);
  // Approver resolution reads delegations through host-ext persistence.
  initHostExtPersistence(storage);
  await storage.insertRun(r);
  await emitInterruptNotification(storage, { interruptId: `int-${r.runId}`, runId: r.runId, nodeId: 'gate_1', kind, token: 'tok', data, createdAt: now });
  const list = await storage.listNotifications({ tenantId: r.tenantId });
  await storage.close();
  return list;
}

const ID_SHAPE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/;
const ENGINE_WORDS = /\b(run|step|interrupt|node|gate)s?\b/i;

describe('D2 — the host composes words a person can read', () => {
  afterEach(() => setNotificationWorkflowNameResolver(null));
  const notified = PROJECTED_HOST_KINDS.filter((k) => !NEVER_NOTIFY_KINDS.has(k));

  for (const named of [true, false]) {
    for (const kind of notified) {
      it(`${kind}, ${named ? 'named' : 'unknown'} workflow: no id, no engine word`, async () => {
        setNotificationWorkflowNameResolver(async () => (named ? 'Weekly client update' : undefined));
        const [n] = await emitted(run('t-1125'), kind, kind === 'credential' ? { provider: 'Google' } : null);
        expect(n, 'the kind notifies').toBeDefined();
        for (const text of [n!.title, n!.message]) {
          expect(text).not.toMatch(ID_SHAPE);
          expect(text).not.toMatch(ENGINE_WORDS);
          // A kind that is an engine word (hyphenated) never appears; `approval`
          // or `cancellation` are plain English and may.
          if (kind.includes('-')) expect(text).not.toContain(kind);
          expect(text).not.toContain('credential');
        }
        if (named) {
          expect(`${n!.title} ${n!.message}`).toContain('Weekly client update');
          expect(n!.metadata?.asker).toBe('Weekly client update');
        } else {
          expect(n!.metadata?.asker).toBeUndefined();
        }
      });
    }
  }

  it('composes the sentence per kind', async () => {
    setNotificationWorkflowNameResolver(async () => 'Weekly client update');
    const title = async (kind: InterruptRecord['kind'], data: unknown = null) => (await emitted(run('t-1125'), kind, data))[0]!.title;
    expect(await title('approval')).toBe('Approval needed: Weekly client update');
    expect(await title('clarification')).toBe('Weekly client update has a question for you');
    expect(await title('refinement')).toBe('Weekly client update asks you to review a draft');
    expect(await title('cancellation')).toBe('Confirm cancelling Weekly client update');
    expect(await title('credential', { provider: 'Google' })).toBe('Connect Google so Weekly client update can continue');
  });

  it('the gate\'s own words still win', async () => {
    setNotificationWorkflowNameResolver(async () => 'Weekly client update');
    const [n] = await emitted(run('t-1125'), 'approval', { title: 'Approve the cabinet order', prompt: '$18,400 to Northfield Millwork.' });
    expect(n!.title).toBe('Approve the cabinet order');
    expect(n!.message).toBe('Weekly client update — $18,400 to Northfield Millwork.');
  });
});

describe('D5 — why it came to you', () => {
  afterEach(() => setNotificationWorkflowNameResolver(null));

  it('a named approver is told they were named', async () => {
    const list = await emitted(run('t-1125'), 'approval', { prompt: 'Approve?', approverRefs: ['u-ana'] });
    expect(list.map((n) => [n.recipientUserId, n.metadata?.reason])).toEqual([['u-ana', { kind: 'named' }]]);
  });

  it('a role-addressed request names the role, and nothing else', async () => {
    const [n] = await emitted(run('t-1125'), 'approval', { prompt: 'Approve?' });
    expect(n!.recipientRole).toBe('admin');
    expect(n!.metadata?.reason).toEqual({ kind: 'role', role: 'admin' });
  });
});
