/**
 * content workflow-chain pack — REAL execution (RFC 0013, ADR 0190 Phase 3).
 *
 * CHAINS CHOSEN: both `content.feed-watch` and `content.page-watch` — the
 * pack's only two chains, structurally identical (`tick` → `fetch` +
 * `seen`/`snapshot` (fan-in) → `diff` (AI) → `remember` + `notify`) and
 * both carrying the SAME two defects (fixed below), so proving one proves
 * the pattern for both.
 *
 * MODE CHOSEN: a hand-rolled mini-scheduler (the `cms-chain-execution.
 * test.ts` precedent) — `diff`'s `core.ai.chatCompletion` config omits
 * `provider`/`model` (an operator-configurable template), so only
 * `ctx.callAI` is faked; `fetch` (REAL SSRF-guarded HTTP to a local test
 * server), `seen`/`snapshot`/`remember` (REAL in-memory `ctx.storage.kv`,
 * via `buildHostSurfaceBundle` — the SAME factory the real executor uses),
 * and `notify` (REAL `ctx.notification.push`, gracefully degrading with no
 * connection configured, exactly as `workflow-chain-exec-ops-execution.
 * test.ts` documents for `calendar`/`finance`) are all REAL. Running the
 * chain TWICE with the SAME `feedUrl` in the SAME tenant proves durable,
 * per-source dedup actually round-trips end to end — not just structurally.
 *
 * TWO BUGS FOUND + FIXED AT THE ROOT (`examples/workflow-chain-packs/
 * content/pack.json`), both empirically verified with a throwaway probe
 * (`POST /v1/runs` + inspect the debug-bundle) before AND after the fix:
 *
 * 1. Multi-fan-in port collision on `diff` (`core.ai.chatCompletion`): TWO
 *    inbound edges (`fetch`→`diff`, `seen`/`snapshot`→`diff`) named
 *    neither `sourceOutput` nor `targetInput` — the SAME defect class as
 *    `csm-ops.health-from-crm`/`exec-ops.*` (see those packs' execution
 *    tests). The scheduler's `buildNodeInputs` (`executor/scheduler.ts`)
 *    clobbered every edge but the LAST into the shared default port key
 *    `'input'`, and the executor's single-key "Back-compat" unwrap then
 *    flattened it to just the LAST edge's raw upstream value — so `diff`
 *    silently lost either the freshly-fetched content or the stored
 *    seen-state on EVERY real run, never both. Fixed with explicit
 *    dot-notation target ports (`fetch`→`diff.fetch`, `seen`→`diff.seen` /
 *    `snapshot`→`diff.snapshot`) so each source lands on its own key.
 *    (Also applied the SAME fix mechanism — dot-notation edges — to the
 *    single-edge `diff`→`remember` link: `diff`'s raw `core.ai.chatCompletion`
 *    output is `{content, usage, finishReason}`, but `core.storage.kv-set`
 *    (`packs/core.openwop.storage/index.mjs`, `delegate('kv','set')`)
 *    needs a top-level `value` key — with the plain edge, `remember` was
 *    calling `.set({key, value: undefined, content, usage, finishReason})`,
 *    silently persisting `value: undefined` on every run. Retargeted to
 *    `diff.content`→`remember.value` so the digest text is what's actually
 *    stored.)
 *
 * 2. A node's static, templated `inputs` field is DEAD: `expandChain`
 *    (`host/workflowChainPackLoader.ts`) preserves an authored node's
 *    `inputs` field through expansion, but `validateWorkflowDefinition`
 *    (called at the end of `expandChain`) strips it entirely before the
 *    definition is ever registered — confirmed empirically (the EXPANDED
 *    node's JSON carries no `inputs` field at all, only `config`). Only
 *    `config` survives to be interpolated at run time
 *    (`interpolateRunInputs(nodeRef.config, variableBag)`,
 *    `executor/executor.ts`). `seen`/`snapshot` (`core.storage.kv-get`) and
 *    `remember` (`core.storage.kv-set`) had their per-source `key` template
 *    (`"seen:{{params.feedUrl}}"` / `"snap:{{params.pageUrl}}"`) ONLY in the
 *    node's static `inputs` field — never in `config` — and since both are
 *    SOURCE nodes (no incoming edge for `seen`/`snapshot`; `remember` now
 *    has one via the fix above but not for `key`), the merged
 *    `{...ctx.config, ...ctx.inputs}` args the storage delegate node reads
 *    (`packs/core.openwop.storage/index.mjs`) never had a `key` field at
 *    all — `.get({key: undefined})`/`.set({key: undefined, ...})` — every
 *    feed/page's "seen" state collided on the SAME literal `undefined` key
 *    in the KV store, so per-source dedup never actually worked (this is
 *    the SAME "static node `inputs` are stripped" lesson the CMS/CRM-chain
 *    precedents already documented, applied to a case where it silently
 *    broke persistence rather than just being redundant). Fixed by
 *    DUPLICATING the `key` template into each node's `config` (kept the
 *    original `inputs.key` UNCHANGED too — `workflow-chain-content.test.ts`,
 *    a shared structural test this session must not edit, asserts on the
 *    raw pre-expansion `chain.dag.nodes[i].inputs.key` shape, so removing
 *    it would break that test; duplicating into `config` is what actually
 *    fixes the runtime behavior without touching that assertion).
 *
 * Both fixes are proven live below: the fake `ctx.callAI` call's captured
 * message content contains BOTH the fetched body and the seen-state
 * (bug 1), and a second run with the same `feedUrl` finds the first run's
 * persisted digest under the CORRECT resolved key (bug 2).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getChain, expandChain, loadWorkflowChainPacks, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { makeNotificationAdapter } from '../src/host/notificationAdapter.js';
import { buildNotificationsSurface } from '../src/features/notifications/surface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface NodeResult { status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } }
type NodeImpl = (ctx: Record<string, unknown>) => Promise<NodeResult>;
let nodeImpls: Record<string, NodeImpl>;
let storage: Storage;
let feedServer: http.Server;
let feedPort: number;
let feedHits = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_HTTP_ALLOW_PRIVATE_RANGES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;

  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs')] });
  expect(errors).toEqual([]);

  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const httpPack = (await import('../../../packs/core.openwop.http/index.mjs')) as { nodes: Record<string, NodeImpl> };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const storagePack = (await import('../../../packs/core.openwop.storage/index.mjs')) as { nodes: Record<string, NodeImpl> };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const integrationPack = (await import('../../../packs/core.openwop.integration/index.mjs')) as { nodes: Record<string, NodeImpl> };
  const aiPack = (await import('../../../packs/core.openwop.ai/index.mjs')) as { nodes: Record<string, NodeImpl> };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const triggerPack = (await import('../../../packs/core.openwop.triggers/index.mjs')) as { nodes: Record<string, NodeImpl> };
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  const notifyPack = (await import('../../../packs/feature.notifications.nodes/index.mjs')) as { nodes: Record<string, NodeImpl> };
  nodeImpls = { ...httpPack.nodes, ...storagePack.nodes, ...integrationPack.nodes, ...aiPack.nodes, ...triggerPack.nodes, ...notifyPack.nodes };

  feedServer = http.createServer((_req, res) => {
    feedHits += 1;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end('<rss><channel><item><title>New feature shipped</title><link>https://example.com/p/1</link></item></channel></rss>');
  });
  await new Promise<void>((res) => feedServer.listen(0, '127.0.0.1', () => { feedPort = (feedServer.address() as AddressInfo).port; res(); }));
});
afterAll(async () => {
  process.env.OPENWOP_HTTP_ALLOW_PRIVATE_RANGES = 'false';
  delete process.env.OPENWOP_HTTP_ALLOW_PRIVATE_RANGES;
  await new Promise<void>((res) => feedServer.close(() => res()));
});

/** Resolve `{{inputs.name}}` config tokens from the run params — mirrors
 *  the real executor's `interpolateRunInputs`. */
function resolveConfig(config: Record<string, unknown> | undefined, params: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).map(([k, v]) => [
    k,
    typeof v === 'string' ? v.replace(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => params[name] ?? '') : v,
  ]));
}

interface CapturedAiCall { messages: Array<{ role: string; content: string }> }

/** Walk the expanded definition with `buildNodeInputs` port semantics (the
 *  SAME resolution rules `csm-ops`/`exec-ops`'s execution tests document),
 *  driving the REAL node implementations against a REAL `ctx.storage`/
 *  `ctx.notification`/HTTP fetch, faking only `ctx.callAI`. */
async function runChain(
  chainId: string,
  params: Record<string, string>,
  tenantId: string,
  runId: string,
  capturedAiCalls: CapturedAiCall[],
): Promise<Record<string, NodeResult>> {
  const chain = getChain(chainId)!.chain;
  const def = expandChain(chain, { params });
  const outputs = new Map<string, Record<string, unknown>>();
  const results: Record<string, NodeResult> = {};
  const surfaceStorage = buildHostSurfaceBundle({ tenantId, runId }).storage;
  const notification = makeNotificationAdapter({ storage, tenantId, runId });
  const callAI = async (args: { messages: Array<{ role: string; content: string }> }) => {
    capturedAiCalls.push({ messages: args.messages });
    return { content: 'NEW ITEMS\n- New feature shipped (https://example.com/p/1)\n\nSEEN\nhttps://example.com/p/1' };
  };

  for (const node of def.nodes) {
    const incoming = (def.edges ?? []).filter((e) => e.targetNodeId === node.nodeId);
    let ctxInputs: unknown = params;
    if (incoming.length > 0) {
      const inputs: Record<string, unknown> = {};
      for (const e of incoming) {
        const src = outputs.get(e.sourceNodeId) ?? {};
        const sourcePort = e.sourceOutput ?? 'output';
        const value = Object.prototype.hasOwnProperty.call(src, sourcePort) ? src[sourcePort] : src;
        inputs[e.targetInput ?? 'input'] = value;
      }
      ctxInputs = Object.keys(inputs).length === 1 && 'input' in inputs ? inputs.input : inputs;
    }
    // ADR 0237 — the REAL executor merges a node's DECLARED `inputs` OVER the
    // edge-derived ones ("fixture wins on conflict"). This harness built inputs
    // from edges only, so a node whose value is authored (not piped) saw nothing:
    // the notify node reported `title_required` for a title the chain declares.
    // Mirroring the executor keeps the harness honest rather than weakening the
    // assertion to match a harness gap.
    const declared = (node as unknown as { inputs?: Record<string, unknown> }).inputs;
    if (declared && Object.keys(declared).length > 0) {
      const base = (ctxInputs && typeof ctxInputs === 'object' && !Array.isArray(ctxInputs))
        ? (ctxInputs as Record<string, unknown>) : {};
      ctxInputs = { ...base, ...resolveConfig(declared, params) };
    }
    const impl = nodeImpls[node.typeId];
    expect(impl, `node impl for ${node.typeId}`).toBeTruthy();
    const ctx = {
      runId, nodeId: node.nodeId, tenantId,
      inputs: ctxInputs,
      config: resolveConfig(node.config, params),
      callAI,
      storage: surfaceStorage,
      notification,
      // The chain now uses the in-app node (feature.notifications.nodes.notify)
      // over the ONE emitter, not the device-push node it could never satisfy.
      features: { notifications: buildNotificationsSurface({ tenantId, runId }) },
      triggerData: params,
    };
    const result = await impl!(ctx);
    const short = node.nodeId.slice(node.nodeId.lastIndexOf('_') + 1);
    results[short] = result;
    if (result.status !== 'success') break;
    outputs.set(node.nodeId, result.outputs ?? {});
  }
  return results;
}

describe('content.feed-watch — end-to-end execution (mini-scheduler, real fetch/storage/notify, fake ctx.callAI)', () => {
  it('real-fetches the feed, threads both fetch+seen distinctly into the digest (BUG 1), persists under the correct key (BUG 2), and a second run finds it', async () => {
    const feedUrl = `http://127.0.0.1:${feedPort}/feed.xml`;
    const params = { feedUrl };
    const tenantId = `org:contentchain-${Date.now()}`;

    const firstCalls: CapturedAiCall[] = [];
    const first = await runChain('content.feed-watch', params, tenantId, 'run:first', firstCalls);
    expect(first.diff?.status, JSON.stringify(first)).toBe('success');
    expect(first.remember?.status, JSON.stringify(first)).toBe('success');
    expect(first.notify?.status, JSON.stringify(first)).toBe('success');

    // BUG 1 proof: the fake callAI's message genuinely carries BOTH the raw
    // fetched XML body AND the (empty, first-run) seen-state as distinct
    // keys — neither clobbered the other.
    expect(firstCalls.length).toBe(1);
    const sentContent = firstCalls[0]!.messages[0]!.content;
    const parsed = JSON.parse(sentContent) as { fetch?: { body?: string }; seen?: { found?: boolean } };
    expect(parsed.fetch?.body).toContain('New feature shipped');
    expect(parsed.seen?.found).toBe(false);

    // remember persisted the digest (not `value: undefined`).
    expect(first.remember?.outputs).toEqual({ ok: true });

    // notify gracefully degrades (no push connection configured).
    // Was `{ sent:false, error:'notification_not_connected' }` — the OLD node
    // degrading to nothing while the run completed green. The in-app node actually
    // DELIVERS (durable inbox row + SSE), so the honest assertion is an emission.
    expect(first.notify?.outputs).toMatchObject({ emitted: true, audience: 'tenant' });

    expect(feedHits).toBe(1);

    // BUG 2 proof: a SECOND run with the SAME feedUrl, in the SAME tenant,
    // finds the FIRST run's persisted digest via the correctly-resolved key
    // (pre-fix, both runs' kv key resolved to the literal string
    // "undefined", so this would ALSO have "worked" — but only by
    // coincidence and only because every distinct feedUrl collided on the
    // SAME bogus key; the isolation proof below (a DIFFERENT feedUrl)
    // is what actually distinguishes correct resolution from the bug).
    const secondCalls: CapturedAiCall[] = [];
    const second = await runChain('content.feed-watch', params, tenantId, 'run:second', secondCalls);
    expect(second.diff?.status, JSON.stringify(second)).toBe('success');
    const secondParsed = JSON.parse(secondCalls[0]!.messages[0]!.content) as { seen?: { found?: boolean; value?: string } };
    expect(secondParsed.seen?.found).toBe(true);
    expect(secondParsed.seen?.value).toContain('https://example.com/p/1');

    // Isolation proof (the actual bug-2 discriminator): a DIFFERENT feedUrl
    // in the SAME tenant must NOT see the first feed's persisted state —
    // pre-fix, both would have collided on the same "undefined" key.
    const otherCalls: CapturedAiCall[] = [];
    const other = await runChain('content.feed-watch', { feedUrl: `http://127.0.0.1:${feedPort}/other-feed.xml` }, tenantId, 'run:other', otherCalls);
    expect(other.diff?.status, JSON.stringify(other)).toBe('success');
    const otherParsed = JSON.parse(otherCalls[0]!.messages[0]!.content) as { seen?: { found?: boolean } };
    expect(otherParsed.seen?.found).toBe(false);
  });
});

describe('content.page-watch — end-to-end execution (same fixes, same harness)', () => {
  it('real-fetches the page, threads both fetch+snapshot distinctly into the report, and persists under the correct key', async () => {
    const pageUrl = `http://127.0.0.1:${feedPort}/pricing`;
    const params = { pageUrl, focus: 'pricing, features, and announcements' };
    const tenantId = `org:contentchain-page-${Date.now()}`;

    const calls: CapturedAiCall[] = [];
    const result = await runChain('content.page-watch', params, tenantId, 'run:page-first', calls);
    expect(result.diff?.status, JSON.stringify(result)).toBe('success');
    expect(result.remember?.status, JSON.stringify(result)).toBe('success');

    expect(calls.length).toBe(1);
    const parsed = JSON.parse(calls[0]!.messages[0]!.content) as { fetch?: { body?: string }; snapshot?: { found?: boolean } };
    expect(parsed.fetch?.body).toContain('New feature shipped');
    expect(parsed.snapshot?.found).toBe(false);
    expect(result.remember?.outputs).toEqual({ ok: true });

    const calls2: CapturedAiCall[] = [];
    await runChain('content.page-watch', params, tenantId, 'run:page-second', calls2);
    const parsed2 = JSON.parse(calls2[0]!.messages[0]!.content) as { snapshot?: { found?: boolean } };
    expect(parsed2.snapshot?.found).toBe(true);
  });
});
