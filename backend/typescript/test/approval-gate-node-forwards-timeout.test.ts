/**
 * RFC 0093 §D.1 / RFC 0223. `core.approvalGate` must carry its own deadline
 * into the interrupt, because that is the only place `approvalGateDeadlineMs`
 * looks. Every other timeout test seeds an interrupt with `data.timeoutMs`
 * directly, so none of them ran THIS node, and a gate configured with
 * `timeoutMs` never timed out. Suite 2.43.1's `v2-approval-reject-disposition`
 * timeout legs run the real node and were the first thing to notice.
 */
import { describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { approvalGateDeadlineMs } from '../src/executor/approvalGateTimeout.js';
import type { InterruptRecord } from '../src/types.js';

async function gateData(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  ensureNodesRegistered();
  const node = getNodeRegistry().get('core.approvalGate');
  expect(node, 'core.approvalGate is registered').not.toBeNull();
  const out = await node!.execute({ config, inputs: {}, nodeId: 'gate', runId: 'r', tenantId: 't' } as never) as { status: string; interrupt?: { data?: Record<string, unknown> } };
  expect(out.status).toBe('suspended');
  return out.interrupt?.data ?? {};
}

describe('core.approvalGate forwards its own deadline', () => {
  it('config.timeoutMs reaches interrupt.data, and the deadline reader sees it', async () => {
    const data = await gateData({ title: 't', actions: ['accept', 'reject'], timeoutMs: 1500 });
    expect(data.timeoutMs).toBe(1500);
    const createdAt = Date.parse('2026-09-28T00:00:00Z');
    const rec = { interruptId: 'i', runId: 'r', kind: 'approval', data, createdAt: new Date(createdAt).toISOString() } as unknown as InterruptRecord;
    expect(approvalGateDeadlineMs(rec)).toBe(createdAt + 1500);
  });

  it('config.timeoutSec is forwarded too; an absent or non-positive timeout forwards nothing', async () => {
    expect((await gateData({ timeoutSec: 30 })).timeoutSec).toBe(30);
    const none = await gateData({ timeoutMs: 0 });
    expect(none).not.toHaveProperty('timeoutMs');
    expect(await gateData({})).not.toHaveProperty('timeoutSec');
  });
});
