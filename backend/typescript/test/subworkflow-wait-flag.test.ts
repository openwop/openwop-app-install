/**
 * ENG-9 resolved by decision (deferred-work review, 2026-07-03):
 * `core.subWorkflow` now EXERCISES the spec's MAY (node-packs.md
 * §core.subWorkflow — "`false` is reserved for a future asynchronous variant;
 * v1 hosts MAY refuse `false` with `validation_error`") instead of the prior
 * silent accept-and-await. Refusing loudly is honest; inventing detached
 * semantics for a reserved field would be an unspecified wire claim.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

beforeAll(() => { ensureNodesRegistered(); });

function ctx(config: Record<string, unknown>): NodeContext {
  return {
    runId: 'run-wff',
    nodeId: 'n1',
    tenantId: 't-wff',
    inputs: {},
    config,
    emit: async () => undefined,
  } as unknown as NodeContext;
}

describe('core.subWorkflow — waitForCompletion flag honesty', () => {
  it('refuses waitForCompletion:false with validation_error (the spec-sanctioned MAY), before any dispatch', async () => {
    const node = getNodeRegistry().get('core.subWorkflow');
    expect(node).toBeTruthy();
    const out = await node!.execute(ctx({ workflowId: 'some-child', waitForCompletion: false }));
    expect(out.status).toBe('failure');
    const err = (out as { error?: { code?: string; message?: string } }).error;
    expect(err?.code).toBe('validation_error');
    expect(err?.message).toMatch(/reserved for a future asynchronous variant/);
  });

  it('still requires workflowId first (existing contract unchanged)', async () => {
    const node = getNodeRegistry().get('core.subWorkflow');
    const out = await node!.execute(ctx({ waitForCompletion: false }));
    expect(out.status).toBe('failure');
    // Missing workflowId is reported before the flag check — the stricter,
    // pre-existing validation stays first.
    expect((out as { error?: { code?: string } }).error?.code).toBe('invalid_request');
  });
});
