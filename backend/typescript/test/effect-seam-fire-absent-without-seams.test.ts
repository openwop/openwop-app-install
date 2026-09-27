/**
 * Guardrail 1 for `fireEffectSeam` (RFC 0173 §C.2): on a boot WITHOUT the
 * conformance seam surface, the seam's node and workflow do not exist.
 *
 * CLAUDE.md forbids a pinned in-tree workflow. The seam's run needs a workflow
 * and a node to exist, so both are created ONLY when the seams profile is on
 * (the `artifactTypeSeam.ts` precedent). This file boots a normal host and pins
 * the absence: the node is not registered, the fire route refuses, and nothing
 * named `conformance.effect-seam.fire` reaches the registry, the ownership
 * index, or the builder / `/` picker listing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { SEAM_ROWS } from '../src/host/effectSeamManifest.js';
import { FIRE_NODE_TYPE, fireWorkflowId } from '../src/routes/effectSeamFireSeam.js';
import { allOwnershipByWorkflow } from '../src/host/workflowOwnership.js';
import { getRegisteredWorkflowAsync, listRegisteredWorkflows } from '../src/host/workflowsRegistry.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const prevSeams = process.env.OPENWOP_TEST_SEAM_ENABLED;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (prevSeams === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED; else process.env.OPENWOP_TEST_SEAM_ENABLED = prevSeams;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('guardrail 1 — a non-seams boot has no effect-seam node or workflow', () => {
  it('the node is not registered, the route refuses, and no workflow appears anywhere', async () => {
    expect(getNodeRegistry().isResolvable(FIRE_NODE_TYPE), 'the node must not exist on a normal boot').toBe(false);
    const seam = SEAM_ROWS[0]?.seam ?? '';
    const res = await fetch(`${base}/v1/host/sample/effect-seams/fire`, { method: 'POST', headers: AUTH, body: JSON.stringify({ seam }) });
    expect(res.status).toBe(404);
    expect(await getRegisteredWorkflowAsync(fireWorkflowId('default', seam)), 'no transient definition was registered').toBeNull();
    expect(listRegisteredWorkflows().some((w) => w.workflowId.startsWith('conformance.effect-seam.fire'))).toBe(false);
    expect([...(await allOwnershipByWorkflow()).keys()].some((id) => id.startsWith('conformance.effect-seam.fire'))).toBe(false);
    const listed = await (await fetch(`${base}/v1/host/openwop-app/workflows`, { headers: AUTH })).text();
    expect(listed).not.toContain('conformance.effect-seam.fire');
  });
});
