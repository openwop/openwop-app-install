/**
 * ADR 0133 Phase 1 — dispatchSubRun stamps the parent-run linkage into the child's
 * run.metadata (via POST /v1/runs body.metadata), and omits it when not linked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchSubRun } from '../src/subruns/subRunDispatcher.js';

function stubFetch(createBodyOut: { body?: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      createBodyOut.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ runId: 'child-1', status: 'running' }), { status: 200 });
    }
    // snapshot poll → terminal completed immediately
    if (/\/v1\/runs\/child-1$/.test(String(url))) {
      return new Response(JSON.stringify({ runId: 'child-1', status: 'completed' }), { status: 200 });
    }
    if (String(url).includes('/events/poll')) {
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('dispatchSubRun parent linkage (ADR 0133 P1)', () => {
  it('stamps metadata.parentRunId + delegatedBy when provided', async () => {
    const out: { body?: any } = {};
    stubFetch(out);
    await dispatchSubRun({ workflowId: 'wf', inputs: {}, budgetMs: 1000, tenantId: 't', parentRunId: 'parent-9', delegatedBy: 'agent:a1' });
    expect(out.body.metadata).toEqual({ parentRunId: 'parent-9', delegatedBy: 'agent:a1' });
  });

  it('omits metadata entirely when no linkage is provided (unchanged create body)', async () => {
    const out: { body?: any } = {};
    stubFetch(out);
    await dispatchSubRun({ workflowId: 'wf', inputs: {}, budgetMs: 1000, tenantId: 't' });
    expect(out.body.metadata).toBeUndefined();
  });
});
