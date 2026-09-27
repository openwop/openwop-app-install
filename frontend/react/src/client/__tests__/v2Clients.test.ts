import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config, setCurrentIdToken } from '../config.js';

/**
 * ADR 0647 — the SPA's protocol clients speak major 2, and this file is the
 * only place that is asserted ON THE WIRE.
 *
 * 22 of the 24 test files around these clients `vi.mock` the client module, so
 * a change of protocol major, path space, or id shape is invisible to every one
 * of them (a peer host migrated v1→v2 and "passed 1503 tests without being
 * exercised once"). This file stubs `globalThis.fetch` and reads back the URL,
 * the headers and the body the client actually sent — the same discipline the
 * backend applies to its own negotiator.
 *
 * It also pins the two surfaces that deliberately STAY on major 1 (discovery,
 * debug bundle) and the agent-management surface that moved from the
 * `/v1/host/sample/*` seam address (404 in production) to the product one.
 */

type Call = { url: string; init: RequestInit | undefined };
const calls: Call[] = [];
const origFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}
function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}
/** Every stub answers the tenant lookup (`me/workspaces` → active tenant
 *  `default`) so a bind can resolve; the route under test handles the rest. */
function stub(route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, init });
    if (url.includes('/me/workspaces')) return json({ workspaces: [], active: 'default', personal: 'default' });
    return route(url, init);
  }) as unknown as typeof fetch;
}
const last = (): Call => calls[calls.length - 1]!;
/** Poll a predicate instead of resolving from inside a stream callback —
 *  a throw inside `onClose` is swallowed by the reconnect loop and reads as a
 *  5 s timeout, which is exactly how the first version of these legs failed. */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}
const BARE = '8f2f3fcf-8cf9-4dd4-84b9-e3f18ef43cc5';
const BOUND = `default/${BARE}`;
/** How the bound id travels in a path: the SDK `encodeURIComponent`s it. */
// RFC 0184 / ADR 0726 — the PATH form is the `~`-projection (survives the Firebase `/api` rewrite that decodes `%2F`).
const ENC = BOUND.replace('/', '~2F');

beforeEach(() => { calls.length = 0; config.authMode = 'bearer'; setCurrentIdToken(null); });
afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks(); });

describe('runs — major 2 on the wire, bare ids in the app', () => {
  it('createRun: unversioned /runs, OpenWOP-Version: 2.0, and the tenant-bound id comes back bare', async () => {
    stub(() => json({ runId: BOUND, status: 'running' }, 201));
    const { createRun } = await import('../runsClient.js');
    const res = await createRun({ workflowId: 'wf', inputs: {} });
    expect(new URL(last().url).pathname).toBe('/runs');
    expect(last().url).not.toContain('/v1/');
    expect(headerOf(last().init, 'OpenWOP-Version')).toBe('2.0');
    expect(res.runId).toBe(BARE);
  });

  it('getRun: the {runId} path parameter is TENANT-BOUND and ~-projected (identity.md §5, RFC 0184); the response is unbound', async () => {
    stub(() => json({ runId: BOUND, workflowId: 'wf', status: 'completed', parentRunId: BOUND }));
    const { getRun } = await import('../runsClient.js');
    const snap = await getRun(BARE);
    const run = calls.find((c) => c.url.includes('/runs/'))!;
    expect(new URL(run.url).pathname).toBe(`/runs/${ENC}`);
    expect(run.url).toContain('~2F');
    expect(run.url, 'the percent form is decoded by the /api rewrite — never send it').not.toContain('%2F');
    expect(headerOf(last().init, 'OpenWOP-Version')).toBe('2.0');
    expect(snap.runId).toBe(BARE);
    expect(snap.parentRunId).toBe(BARE);
  });

  it('pollEvents: the v1 cursor name at the app boundary becomes afterSequence on the wire; event ids are unbound', async () => {
    stub(() => json({ runId: BOUND, events: [{ eventId: 'e1', runId: BOUND, type: 'node.completed', payload: {}, timestamp: 't', sequence: 8, schemaVersion: 3 }], lastSequence: 8, status: 'running', isTerminal: false }));
    const { pollEvents } = await import('../runsClient.js');
    const page = await pollEvents(BARE, 7);
    const u = new URL(calls.find((c) => c.url.includes('/events/poll'))!.url);
    expect(u.pathname).toBe(`/runs/${ENC}/events/poll`);
    expect(u.searchParams.get('afterSequence')).toBe('7');
    expect(u.searchParams.get('lastSequence')).toBeNull();
    expect(page.events[0]!.runId).toBe(BARE);
  });

  it('pollEvents: a RENAMED wire type arrives in the SPA\'s v1 dialect (the fixture above used an unrenamed type and could not see this)', async () => {
    stub(() => json({ runId: BOUND, events: [
      { eventId: 'e1', runId: BOUND, type: 'agent.tool-called', payload: {}, timestamp: 't', sequence: 8, schemaVersion: 3 },
      { eventId: 'e2', runId: BOUND, type: 'agent.reasoning-delta', payload: {}, timestamp: 't', sequence: 9, schemaVersion: 3 },
      { eventId: 'e3', runId: BOUND, type: 'node.completed', payload: {}, timestamp: 't', sequence: 10, schemaVersion: 3 },
    ], lastSequence: 10, status: 'running', isTerminal: false }));
    const { pollEvents } = await import('../runsClient.js');
    const page = await pollEvents(BARE, 7);
    expect(page.events.map((e) => e.type)).toEqual(['agent.toolCalled', 'agent.reasoning.delta', 'node.completed']);
    expect(page.events.every((e) => e.runId === BARE)).toBe(true);
  });
});

describe('identity.md §5 on the request side', () => {
  it('never puts a BARE run id in a major-2 path — every /runs/{runId} request carries tenant~2Fopaque', async () => {
    stub(() => json({ runId: BOUND, workflowId: 'wf', status: 'completed' }));
    const { getRun, cancelRun } = await import('../runsClient.js');
    await getRun(BARE);
    await cancelRun(BARE);
    const v2 = calls.filter((c) => new URL(c.url).pathname.startsWith('/runs/'));
    expect(v2.length).toBeGreaterThan(0);
    for (const c of v2) {
      expect(new URL(c.url).pathname, c.url).not.toContain(`/runs/${BARE}`);
      expect(new URL(c.url).pathname, c.url).toContain(`/runs/${ENC}`);
    }
  });
});

describe('ADR 0730 C.3, CORRECTED — the discovery read STAYS on major 1', () => {
  // C.3 moved this read to the v2 root and this block asserted that. It is
  // reverted, and the assertions are inverted BACK rather than deleted, because
  // this is where the claim is checked either way.
  //
  // WHY. The v2 root is a different, CLOSED document, and it is not yet a
  // superset of what this SPA reads. MEASURED against the served v2 doc:
  // `demoMode` moved to `extensions[openwop-app.host]`, `hostSurfaces` to
  // `extensions[openwop-app.host-surfaces]`, and `aiProviders.input`,
  // `memory.attribution` and `envelopes.tierOneSubsetCompliance` are ABSENT —
  // the `memory` and `envelopes` families are not advertised at major 2 at all.
  // Switching the read regressed five UI surfaces silently, because every
  // consumer meets a failed read with a `catch` that renders nothing.
  //
  // The C.3a v2 ADVERTS are unaffected and stay: they are what a v2 client
  // reads. Only the SPA's own read is back on major 1.
  it('getCapabilities reads the major-1 document — asserted on the REQUEST, because the cache would hide it', async () => {
    stub(() => json({ capabilities: { prompts: { supported: true } }, demoMode: true }));
    const { getCapabilities, clearCapabilitiesCache } = await import('../runsClient.js');
    clearCapabilitiesCache();
    await getCapabilities();
    expect(new URL(last().url).pathname).toBe('/.well-known/openwop');
    const v = headerOf(last().init, 'OpenWOP-Version');
    expect(v === null || v.startsWith('1'), `the discovery read must not ask for major 2 (got ${String(v)})`).toBe(true);
  });

  it('the v1-shaped fields the SPA actually reads survive the round trip', async () => {
    // A regression here is the shape of the five silent failures: the read
    // succeeds, the field is undefined, and the feature renders nothing.
    stub(() => json({ capabilities: { hostSurfaces: [{ name: 'host.cache', supported: true, implementation: 'in-memory' }] }, demoMode: true }));
    const { getCapabilities, clearCapabilitiesCache } = await import('../runsClient.js');
    clearCapabilitiesCache();
    const caps = await getCapabilities() as { demoMode?: boolean; capabilities?: { hostSurfaces?: unknown[] } };
    expect(caps.demoMode, 'demoMode gates the BYOK try-it-free affordance').toBe(true);
    expect(caps.capabilities?.hostSurfaces, 'hostSurfaces gates the in-memory disclosure banner').toHaveLength(1);
  });

  it('getDebugBundle hits the HOST-EXTENSION twin — the address that survives v1 retirement', async () => {
    // C.1 is NOT reverted: this operation has no v2 path in the manifest, the
    // twin is verified, and it is the one read that genuinely moved.
    stub(() => json({ runId: BARE, events: [] }));
    const { getDebugBundle } = await import('../runsClient.js');
    await getDebugBundle(BARE);
    expect(new URL(last().url).pathname).toBe(`/host/openwop-app/runs/${BARE}/debug-bundle`);
  });
});

describe('ADR 0730 C.4 — the last SPA reads that spoke v1 protocol', () => {
  // Four modules each held their own `fetch(baseUrl + "/v1/workflows/" + id)`
  // and one held `/v1/runs/{id}`; the prompt library held `/v1/prompts`. They
  // now share one major-2 owner each. These legs assert the ADDRESS and the
  // VERSION, because a wrapper that reached the same data over the old wire
  // would pass every other test in the suite.
  it('getWorkflowDefinitionRaw: unversioned /workflows/{id} at major 2', async () => {
    stub(() => json({ workflowId: 'wf-1', nodes: [], variables: [{ name: 'topic', required: true }] }));
    const { getWorkflowDefinitionRaw } = await import('../workflowsClient.js');
    await getWorkflowDefinitionRaw('wf-1');
    expect(new URL(last().url).pathname).toBe('/workflows/wf-1');
    expect(headerOf(last().init, 'OpenWOP-Version')).toBe('2.0');
  });

  it('a not-found yields null — every caller degrades to a reduced UI, none of them wants a throw', async () => {
    stub(() => json({ error: 'not_found', message: 'no such workflow' }, 404));
    const { getWorkflowDefinitionRaw } = await import('../workflowsClient.js');
    await expect(getWorkflowDefinitionRaw('gone')).resolves.toBeNull();
  });

  it('a 500 THROWS — this is the leg that keeps the helper honest', async () => {
    // A swallow-everything helper would return null here, and
    // `getWorkflowRunInputs` would report "this workflow declares no inputs"
    // for a workflow that declares several. The run would then launch with an
    // empty variable bag instead of refusing, which is a wrong ANSWER rather
    // than a visible failure. Null must mean absent, never unreadable.
    stub(() => new Response('boom', { status: 500 }));
    const { getWorkflowDefinitionRaw } = await import('../workflowsClient.js');
    await expect(getWorkflowDefinitionRaw('wf-1')).rejects.toBeTruthy();
  });

  it('getWorkflowRunInputs reads variables off that same major-2 read', async () => {
    stub(() => json({ workflowId: 'wf-1', variables: [{ name: 'topic', required: true }] }));
    const { getWorkflowRunInputs } = await import('../../workflows/workflowsClient.js');
    await expect(getWorkflowRunInputs('wf-1')).resolves.toEqual([{ name: 'topic', required: true }]);
    expect(new URL(last().url).pathname).toBe('/workflows/wf-1');
  });

  it('the walkthrough run snapshot is TENANT-BOUND — a bare id does not address a major-2 run', async () => {
    stub(() => json({ runId: BOUND, status: 'waiting_for_input' }));
    const { getRun } = await import('../runsClient.js');
    await getRun(BARE);
    expect(new URL(last().url).pathname).toBe(`/runs/${ENC}`);
  });

  it('the prompt library reads unversioned /prompts at major 2', async () => {
    // Both caches are memoized for the page lifetime, so the stub below is
    // invisible without clearing them. `vi.resetModules()` LOOKS like the fix
    // and is not: it hands the fresh graph its own `config` module, so the
    // `config.authMode` a later test sets lands on an instance nothing reads,
    // and the cookie-mode SSE test fails several blocks away.
    const { clearCapabilitiesCache } = await import('../runsClient.js');
    const { clearPromptsSupportCache } = await import('../../prompts/promptsClient.js');
    clearCapabilitiesCache();
    clearPromptsSupportCache();
    // TWO MAJORS ON PURPOSE, and it is not an oversight: the support GATE reads
    // the major-1 discovery document (C.3 reverted — see the block above), while
    // the prompts READ itself is a major-2 call on the unversioned path. So the
    // stub answers discovery in the v1 shape and the list in the v2 one.
    stub((url) => (url.includes('/.well-known/openwop')
      ? json({ capabilities: { prompts: { supported: true } } })
      : json({ items: [{ templateId: 'p1', kind: 'system' }] })));
    const { listPrompts } = await import('../../prompts/promptsClient.js');
    await listPrompts({ kind: 'system' });
    const read = calls.find((c) => new URL(c.url).pathname === '/prompts');
    expect(read, 'the list read must be the unversioned major-2 path').toBeTruthy();
    expect(new URL(read!.url).searchParams.get('kind'), 'the filter survives the move off the hand-built query string').toBe('system');
    expect(headerOf(read!.init, 'OpenWOP-Version')).toBe('2.0');
  });
});

describe('agent management — the product surface, never the sample seam', () => {
  it('createUserAgent POSTs /host/openwop-app/agents', async () => {
    stub(() => json({ agentId: 'user.x', persona: 'x', label: 'x', modelClass: 'chat', packName: 'user:t', packVersion: '0', toolAllowlist: [] }, 201));
    const { createUserAgent } = await import('../agentsClient.js');
    const rec = await createUserAgent({ persona: 'x', modelClass: 'chat', systemPrompt: 'hi' });
    expect(new URL(last().url).pathname).toBe('/host/openwop-app/agents');
    expect(last().init?.method).toBe('POST');
    expect(last().url).not.toContain('host/sample');
    expect(rec.agentId).toBe('user.x');
  });

  it('deleteUserAgent: 204 → true, 404 → false, anything else THROWS (a 403 is not "already gone")', async () => {
    const { deleteUserAgent } = await import('../agentsClient.js');
    stub(() => new Response(null, { status: 204 }));
    expect(await deleteUserAgent('user.x')).toBe(true);
    expect(new URL(last().url).pathname).toBe('/host/openwop-app/agents/user.x');
    stub(() => json({ error: 'not_found', message: 'no' }, 404));
    expect(await deleteUserAgent('user.x')).toBe(false);
    stub(() => json({ error: 'forbidden', message: 'no' }, 403));
    await expect(deleteUserAgent('user.x')).rejects.toMatchObject({ status: 403 });
  });

  it('listAvailableAgentPacks: a 404 THROWS instead of rendering as an empty catalogue', async () => {
    const { listAvailableAgentPacks } = await import('../agentsClient.js');
    stub(() => json({ packs: [{ name: 'core.openwop.agents.x', version: '1.0.0', personas: ['a'], installed: false }], total: 1, canInstall: true }));
    const ok = await listAvailableAgentPacks();
    expect(new URL(last().url).pathname).toBe('/host/openwop-app/registry/agent-packs');
    expect(ok.packs).toHaveLength(1);
    expect(ok.canInstall).toBe(true);
    stub(() => json({ error: 'not_found', message: 'no' }, 404));
    await expect(listAvailableAgentPacks()).rejects.toMatchObject({ status: 404 });
  });

  it('installAgentPack POSTs /host/openwop-app/registry/agent-packs/install', async () => {
    stub(() => json({ name: 'core.openwop.agents.x', version: '1.0.0', installed: true, alreadyInstalled: false }));
    const { installAgentPack } = await import('../agentsClient.js');
    await installAgentPack('core.openwop.agents.x', '1.0.0');
    expect(new URL(last().url).pathname).toBe('/host/openwop-app/registry/agent-packs/install');
    expect(JSON.parse(String(last().init?.body))).toEqual({ name: 'core.openwop.agents.x', version: '1.0.0' });
  });
});

describe('SSE — one transport, major 2, this app\'s auth', () => {
  function sse(frames: string): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(frames)); c.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const FRAME = `event: node.completed\ndata: ${JSON.stringify({ eventId: 'e1', runId: BOUND, type: 'node.completed', payload: {}, timestamp: 't', sequence: 1, schemaVersion: 3 })}\n\n`;

  it('bearer mode: GET /runs/{id}/events with OpenWOP-Version: 2.0 and text/event-stream; the event id is unbound', async () => {
    stub(() => sse(FRAME));
    const { subscribeToRun } = await import('../streamsClient.js');
    const got: string[] = [];
    let closed = false;
    const sub = subscribeToRun(BARE, { onEvent: (ev) => { got.push(ev.runId); }, onClose: () => { closed = true; } });
    await waitFor(() => closed);
    sub.close();
    expect(closed).toBe(true);
    const call = calls.find((c) => c.url.includes('/events') && !c.url.includes('/token'))!;
    const u = new URL(call.url);
    expect(u.pathname).toBe(`/runs/${ENC}/events`);
    expect(call.url).not.toContain('/v1/');
    expect(headerOf(call.init, 'OpenWOP-Version')).toBe('2.0');
    expect(headerOf(call.init, 'Accept')).toBe('text/event-stream');
    expect(headerOf(call.init, 'authorization')).toMatch(/^Bearer /);
    expect(u.searchParams.get('streamToken')).toBeNull();
    expect(got).toEqual([BARE]);
  });

  it('a RENAMED wire type on the stream reaches onEvent in the SPA\'s v1 dialect', async () => {
    const renamed = `event: agent.tool-called\ndata: ${JSON.stringify({ eventId: 'e2', runId: BOUND, type: 'agent.tool-called', payload: {}, timestamp: 't', sequence: 2, schemaVersion: 3 })}\n\n`;
    stub(() => sse(FRAME + renamed));
    const { subscribeToRun } = await import('../streamsClient.js');
    const types: string[] = [];
    let closed = false;
    const sub = subscribeToRun(BARE, { onEvent: (ev) => { types.push(ev.type); }, onClose: () => { closed = true; } });
    await waitFor(() => closed);
    sub.close();
    expect(types).toEqual(['node.completed', 'agent.toolCalled']);
  });

  it('cookie mode: no bearer, so a run-scoped streamToken minted from the VENDOR token route (ADR 0654) rides the stream URL', async () => {
    config.authMode = 'cookie';
    stub((url) => url.includes('/events/token') ? json({ streamToken: 'tok-1' }) : sse(FRAME));
    const { subscribeToRun } = await import('../streamsClient.js');
    let closed = false;
    const sub = subscribeToRun(BARE, { onEvent: () => {}, onClose: () => { closed = true; } });
    await waitFor(() => closed);
    sub.close();
    expect(closed).toBe(true);
    const token = calls.find((c) => c.url.includes('/events/token'))!;
    expect(new URL(token.url).pathname).toBe(`/host/openwop-app/runs/${BARE}/events/token`); // ADR 0654: vendor namespace, not /v1
    const stream = calls.find((c) => c.url.includes('/events') && !c.url.includes('/token'))!;
    const u = new URL(stream.url);
    expect(u.pathname).toBe(`/runs/${ENC}/events`);
    expect(u.searchParams.get('streamToken')).toBe('tok-1');
    expect(headerOf(stream.init, 'authorization')).toBeNull();
    expect(stream.init?.credentials).toBe('include');
  });
});
