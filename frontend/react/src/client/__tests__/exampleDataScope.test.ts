/**
 * ADR 0292 (`0292-resilient-example-data-seeding`) §Correction 2026-11-07 — the client half
 * of seed workspace intent. `withExampleDataScope` (exampleDataClient.ts) reads the opaque
 * active workspace from a fresh `/me/workspaces` (`listMyWorkspaces({ rememberTenant:
 * false })`, so the wire-tenant binder is not warmed), sends it as `expectedTenantId` on
 * every mutation (run / clear / provision-demo / legacy seed), never on the read-only
 * dry-run preview, and refuses with "workspace changed" if auth changes while the scope
 * read, the write or the progress replay is in flight. Only the exact walkthrough-only
 * seed takes the same-origin JSON lane; every other selection keeps the direct NDJSON
 * stream. The tenant is never inferred from a bearer or URL.
 *
 * Sabotage-witnessed (w94 probes): widening the JSON-lane predicate reds the mixed/duplicate
 * rows; dropping `expectedTenantId` from the stream or JSON body reds the transport and
 * mutation cases; scoping the dry run reds the preview leg; accepting an empty `active`
 * reds the refusal case; removing the post-read `assertCurrent` reds the pending-auth case
 * (on its call count, not a timeout); not setting `changed` or removing the JSON-lane
 * progress checks reds the stale-completion case (double guard: the outer `assertCurrent`
 * still rejects, so "no progress emitted" is the load-bearing assertion); the
 * `rememberTenant` opt-out reds the cache-boundary cases.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listMyWorkspaces } from '../workspaceClient.js';
import * as wireTenant from '../v2Wire.js';
import { fireAuthChanged } from '../config.js';
import { clearExampleData, clearExampleDataStream, provisionDemoTenant, runExampleDataSeed, runExampleDataSeedStream } from '../exampleDataClient.js';
import type { RunResult, SeedStreamEvent } from '../exampleDataClient.js';
import { seedExampleAgents } from '../../agents/rosterClient.js';

vi.mock('../config.js', async (original) => {
  const actual = await original<typeof import('../config.js')>();
  return { ...actual, config: { ...actual.config, baseUrl: '/api', sseBaseUrl: 'https://streams.invalid' } };
});
const result = { success: true, dryRun: false, results: [{ step: 'demo-walkthroughs', label: 'Guided walkthroughs', action: 'created', message: '2 created' }], summary: { created: 1, skipped: 0, cleared: 0, errors: 0, total: 1 } } satisfies RunResult;
const onEvent = () => vi.fn<(event: SeedStreamEvent) => void>();
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stream = (): Response => new Response(JSON.stringify({ type: 'step', ...result.results[0] }) + '\n' + JSON.stringify({ type: 'summary', success: true, summary: result.summary }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); wireTenant.resetWireTenant(); });

function fixture(active = 'ws:qa') {
  const writes: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url === '/api/host/openwop-app/me/workspaces') return json({ active, personal: 'user:personal', workspaces: [] });
    const body: unknown = JSON.parse(String(init.body));
    if (!isRecord(body)) throw new Error(`Write to ${url} sent a non-object body`);
    writes.push({ url, init, body });
    if (url.endsWith('/seed')) return new Response(JSON.stringify({ type: 'result', result: { seeded: true, agents: 2 } }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    return new Headers(init.headers).get('accept') === 'application/x-ndjson' ? stream() : json(result);
  });
  vi.stubGlobal('fetch', fetcher);
  return { writes, fetcher };
}

describe('example-data workspace intent', () => {
  it('uses same-origin JSON only for the exact walkthrough selection and emits compatible progress', async () => {
    const { writes } = fixture();
    const events = onEvent();
    const final = await runExampleDataSeedStream({ steps: ['demo-walkthroughs'] }, events);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe('/api/host/openwop-app/example-data/run');
    expect(writes[0]?.body).toEqual({ steps: ['demo-walkthroughs'], expectedTenantId: 'ws:qa' });
    expect(new Headers(writes[0]?.init.headers).get('accept')).not.toBe('application/x-ndjson');
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['step', 'summary']);
    expect(final).toEqual({ success: true, summary: result.summary });
  });

  it.each<{ label: string; steps: string[] | undefined }>([
    { label: 'omitted', steps: undefined },
    { label: 'empty', steps: [] },
    { label: 'mixed', steps: ['demo-walkthroughs', 'agents'] },
    { label: 'duplicate', steps: ['demo-walkthroughs', 'demo-walkthroughs'] },
  ])('retains the direct NDJSON transport for $label selection', async ({ steps }) => {
    const { writes } = fixture('user:personal');
    await runExampleDataSeedStream(steps === undefined ? {} : { steps }, onEvent());
    expect(writes[0]?.url).toBe('https://streams.invalid/host/openwop-app/example-data/run');
    expect(writes[0]?.body.expectedTenantId).toBe('user:personal');
    expect(writes[0]?.body.steps).toEqual(steps);
    expect(new Headers(writes[0]?.init.headers).get('accept')).toBe('application/x-ndjson');
  });

  it('asserts the fresh opaque workspace on clear, provision and legacy seed without changing their transport', async () => {
    const { writes } = fixture();
    await clearExampleDataStream({ steps: ['demo-walkthroughs'] }, onEvent());
    await provisionDemoTenant(onEvent());
    await seedExampleAgents({ heal: true });
    expect(writes.map((write) => write.url)).toEqual(['clear', 'provision-demo', 'seed'].map((path) => `https://streams.invalid/host/openwop-app/example-data/${path}`));
    expect(writes.map((write) => write.body.expectedTenantId)).toEqual(['ws:qa', 'ws:qa', 'ws:qa']);
    expect(writes[2]?.body.heal).toBe(true);
  });

  it('asserts workspace on JSON mutations but permits an assertion-free read-only preview', async () => {
    const { writes } = fixture();
    await runExampleDataSeed({ steps: ['agents'] });
    await clearExampleData({ steps: ['agents'] });
    await runExampleDataSeed({ dryRun: true });
    expect(writes.map((write) => write.body.expectedTenantId)).toEqual(['ws:qa', 'ws:qa', undefined]);
    expect(writes[2]?.body.dryRun).toBe(true);
  });

  it('refuses missing workspace and failed scope reads without any POST', async () => {
    const { writes } = fixture('');
    await expect(runExampleDataSeedStream({ steps: ['demo-walkthroughs'] }, onEvent())).rejects.toThrow('active workspace');
    expect(writes).toEqual([]);
    const fetcher = vi.fn(async (): Promise<Response> => json({ message: 'scope unavailable' }, 503));
    vi.stubGlobal('fetch', fetcher);
    await expect(clearExampleDataStream({}, onEvent())).rejects.toThrow('scope unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not submit after an auth change while the real scope read is pending', async () => {
    let resolveScope: ((value: Response) => void) | undefined;
    let calls = 0;
    // Only the scope read is held; any later call answers at once, so a write that
    // slips past the guard shows up as a second call instead of hanging the case.
    const fetcher = vi.fn((): Promise<Response> => calls++ === 0
      ? new Promise<Response>((resolve) => { resolveScope = resolve; })
      : Promise.resolve(json(result)));
    vi.stubGlobal('fetch', fetcher);
    const pending = runExampleDataSeedStream({ steps: ['demo-walkthroughs'] }, onEvent());
    fireAuthChanged();
    if (!resolveScope) throw new Error('Scope request did not start');
    resolveScope(json({ active: 'ws:old' }));
    await expect(pending).rejects.toThrow('workspace changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale successful JSON completion without emitting progress for the new workspace', async () => {
    const events = onEvent();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/me/workspaces')) return json({ active: 'ws:qa' });
      fireAuthChanged();
      return json(result);
    }));
    await expect(runExampleDataSeedStream({ steps: ['demo-walkthroughs'] }, events)).rejects.toThrow('workspace changed');
    expect(events).not.toHaveBeenCalled();
  });
});


describe('workspace capture cache boundary', () => {
  it('reads the real workspace transport without warming the binder when capture opts out', async () => {
    fixture('ws:old-response');
    wireTenant.resetWireTenant();
    const remember = vi.spyOn(wireTenant, 'rememberWireTenant');
    expect((await listMyWorkspaces({ rememberTenant: false })).active).toBe('ws:old-response');
    expect(remember).not.toHaveBeenCalled();
    const resolveCurrent = vi.fn(async () => ({ active: 'ws:current' }));
    expect(await wireTenant.ensureWireTenant(resolveCurrent)).toBe('ws:current');
    expect(resolveCurrent).toHaveBeenCalledTimes(1);
  });

  it('preserves default workspace-reader cache warming for existing callers', async () => {
    fixture('ws:normal');
    wireTenant.resetWireTenant();
    const remember = vi.spyOn(wireTenant, 'rememberWireTenant');
    expect((await listMyWorkspaces()).active).toBe('ws:normal');
    expect(remember).toHaveBeenCalledWith('ws:normal');
    const unexpectedResolve = vi.fn(async () => ({ active: 'ws:wrong' }));
    expect(await wireTenant.ensureWireTenant(unexpectedResolve)).toBe('ws:normal');
    expect(unexpectedResolve).not.toHaveBeenCalled();
  });
});
