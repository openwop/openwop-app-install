/**
 * RFC 0093 §D.1 / RFC 0223. `core.approvalGate` must carry its own deadline
 * into the interrupt, because that is the only place `approvalGateDeadlineMs`
 * looks. Every other timeout test seeds an interrupt with `data.timeoutMs`
 * directly, so none of them ran THIS node, and a gate configured with
 * `timeoutMs` never timed out. Suite 2.43.1's `v2-approval-reject-disposition`
 * timeout legs run the real node and were the first thing to notice.
 *
 * TST-BXF-5. Red when: the node stops forwarding `timeoutMs` or `timeoutSec`
 * (bootstrap/nodes.ts), forwards a zero/negative value, or the deadline reader
 * stops adding `timeoutMs` to `createdAt` (w66 probes agt-ms/sec/pos/secpos/reader).
 */
import { describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { approvalGateDeadlineMs } from '../src/executor/approvalGateTimeout.js';
import type { NodeContext } from '../src/executor/types.js';
import type { InterruptRecord } from '../src/types.js';

function ctx(config: Record<string, unknown>): NodeContext {
  return {
    runId: 'r', nodeId: 'gate', tenantId: 't', inputs: {}, config, configurable: {},
    attempt: 1, secrets: {},
    emit: async () => ({ eventId: 'e', sequence: 0 }),
  };
}

async function gateData(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  ensureNodesRegistered();
  const node = getNodeRegistry().get('core.approvalGate');
  expect(node, 'core.approvalGate is registered').not.toBeNull();
  const out = await node!.execute(ctx(config));
  if (out.status !== 'suspended') throw new Error(`expected a suspended gate, got ${out.status}`);
  return (out.interrupt.data ?? {}) as Record<string, unknown>;
}

describe('core.approvalGate forwards its own deadline', () => {
  it('config.timeoutMs reaches interrupt.data, and the deadline reader sees it', async () => {
    const data = await gateData({ title: 't', actions: ['accept', 'reject'], timeoutMs: 1500 });
    expect(data.timeoutMs).toBe(1500);
    const createdAt = Date.parse('2026-09-28T00:00:00Z');
    const rec: InterruptRecord = {
      interruptId: 'i', runId: 'r', nodeId: 'gate', kind: 'approval', token: 'tok',
      data, createdAt: new Date(createdAt).toISOString(),
    };
    expect(approvalGateDeadlineMs(rec)).toBe(createdAt + 1500);
  });

  it('config.timeoutSec is forwarded too; an absent or non-positive timeout forwards nothing', async () => {
    expect((await gateData({ timeoutSec: 30 })).timeoutSec).toBe(30);
    const none = await gateData({ timeoutMs: 0 });
    expect(none).not.toHaveProperty('timeoutMs');
    expect(await gateData({ timeoutSec: 0 })).not.toHaveProperty('timeoutSec');
    expect(await gateData({})).not.toHaveProperty('timeoutSec');
  });
});
