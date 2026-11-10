/**
 * ADR 1016 D3/D4b — the model router decides PER TURN on the real chat exchange,
 * and a routed model that cannot serve the key degrades once.
 *
 * Driven through `handleConversationResolve` (the one chat exchange) with only the
 * network and the key stubbed, so the wiring is what is under test: the route must
 * be resolved on every exchange and must reach `dispatchReply`.
 *
 * Breaks if:
 *  - the route is stamped once again (exchange 2 — a short turn — would still be
 *    dispatched on the long turn's model; exchange 3 proves it is decided afresh);
 *  - the exchange stops passing the route to dispatch (every turn on the own model);
 *  - turning the router OFF leaves a conversation routed (the OFF leg);
 *  - a routed model's 404 fails the turn instead of degrading once to the
 *    conversation's own model, or the degrade is not what `served` reports (H1),
 *    or the persisted turn's `agent.model` names the routed model that failed;
 *  - a managed conversation resolves a route at all;
 *  - a 404 with NO route is retried on another model (control: nothing chose it).
 *
 * Sabotage-witnessed (wave 82): dropping `turnRoute` from the exchange's
 * `dispatchReply` call reds the per-turn and MR66CD-1 cases; a route that ignores
 * the turn's text reds the per-turn case; ignoring `enabled` reds OFF; defaulting a
 * ref-less run to a BYOK ref reds the managed case; provenance that ignores
 * `served` reds MR66CD-1; no degrade target, or `served` naming the failed model,
 * reds the D4b case and MR66CD-1; a "fallback" with no route reds the CONTROL.
 * The `metadata.modelRoute` absence check has no write path left to sabotage: it
 * guards against re-introducing the stamp.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls: string[] = [];
let failures: Error[] = [];
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return {
    ...actual,
    dispatchChat: vi.fn(async (req: { model: string }) => {
      calls.push(req.model);
      const next = failures.shift();
      if (next) throw next;
      return { completion: `answered by ${req.model}`, usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});
vi.mock('../src/byok/secretResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/byok/secretResolver.js')>();
  return { ...actual, resolveSecret: vi.fn(async () => 'test-key') };
});

import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { modelRouterFeature } from '../src/features/model-router/feature.js';
import { setRouterConfig, setRouterEnabled } from '../src/features/model-router/configService.js';
import { handleConversationResolve } from '../src/host/conversationExchange.js';
import { resolveTurnModelRoute } from '../src/features/model-router/resolveRoute.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr1016-')) });
initHostExtPersistence(storage);

const TENANT = 't-adr1016';
const OWN = 'claude-haiku-4-5';
const BIG = 'claude-opus-5-5';
const LONG = 'Explain this in depth. '.repeat(200); // ~1150 tokens, over the 1000 threshold
const BYOK = { provider: 'anthropic', model: OWN, credentialRef: 'byok:anthropic' };

function field(value: unknown, ...path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

beforeAll(async () => {
  const toggle = modelRouterFeature.toggleDefault;
  if (!toggle) throw new Error('model-router toggle default is not declared');
  registerToggleDefault(toggle);
  await setRouterConfig(TENANT, 'u1', {
    rules: [{ when: { kind: 'tokensOver', threshold: 1000 }, target: { provider: 'anthropic', model: BIG } }],
  });
  await setRouterEnabled(TENANT, 'u1', true);
});

/** Seed an opened conversation run + its suspended gate interrupt. */
async function seedConversation(runId: string, inputs: Record<string, unknown>): Promise<InterruptRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId, workflowId: 'openwop-app.conversation', tenantId: TENANT,
    status: 'waiting-input', inputs, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const conversationId = `${runId}:gate:0`;
  await storage.appendEvent({
    eventId: `${runId}-open`, runId, type: 'conversation.opened', nodeId: 'gate',
    payload: { conversationId, initialTurn: { conversationId, turnIndex: 0, role: 'system', from: 'system', content: 'Started.', ts: Date.now(), messageId: `${conversationId}:0` } },
    timestamp: now,
  });
  return { interruptId: `${runId}:gate`, runId, nodeId: 'gate', kind: 'conversation', token: `${runId}:gate:token`, data: { conversationId }, createdAt: now };
}

const exchange = (interrupt: InterruptRecord, content: string) =>
  handleConversationResolve(storage, interrupt, { operation: 'exchange', turn: { content } }, async () => {});

describe('ADR 1016 D3 — the route is decided on EVERY exchange of the real chat', () => {
  it('long → routed, short → own model, long again → routed (never frozen, never stamped)', async () => {
    const interrupt = await seedConversation('r-adr1016-turns', BYOK);
    calls.length = 0;
    await exchange(interrupt, LONG);
    await exchange(interrupt, 'thanks');
    await exchange(interrupt, LONG);
    expect(calls).toEqual([BIG, OWN, BIG]);
    // Nothing was written to the run for the next turn to inherit.
    expect((await storage.getRun('r-adr1016-turns'))?.metadata['modelRoute']).toBeUndefined();
  });

  it('OFF means OFF: with routing disabled the same long turn uses the conversation\'s own model', async () => {
    const interrupt = await seedConversation('r-adr1016-off', BYOK);
    await setRouterEnabled(TENANT, 'u1', false);
    try {
      calls.length = 0;
      await exchange(interrupt, LONG);
      expect(calls).toEqual([OWN]);
    } finally {
      await setRouterEnabled(TENANT, 'u1', true);
    }
  });

  it('a managed conversation is never routed: no route is even resolved (the default ref)', async () => {
    // Asserted on the exchange's OWN entry, not on a dispatch the managed tier may
    // never reach (the first cut caught every error and asserted an absence —
    // vacuous; code grade MR66CD-3).
    await expect(resolveTurnModelRoute({
      tenantId: TENANT, runInputs: { provider: 'anthropic' }, // no ref ⇒ the managed default
      credentialProviders: ['anthropic', 'openai', 'google'], userText: LONG,
    })).resolves.toBeNull();
    // CONTROL: the same conversation with a BYOK key IS routed.
    await expect(resolveTurnModelRoute({
      tenantId: TENANT, runInputs: BYOK, credentialProviders: ['anthropic', 'openai', 'google'], userText: LONG,
    })).resolves.toEqual({ provider: 'anthropic', model: BIG });
  });

  it('a routed model that degraded is NOT what the turn\'s agent.model claims (MR66CD-1)', async () => {
    // An ADDRESSED agent: only an agent turn carries `agent.model`.
    getAgentRegistry().register({
      agentId: 'test.adr1016-answerer', persona: 'Answerer', modelClass: 'chat',
      systemPrompt: 'You answer.', toolAllowlist: [], packName: 'core.openwop.test', packVersion: '0',
    });
    const interrupt = await seedConversation('r-adr1016-prov', BYOK);
    calls.length = 0;
    failures = [new Error('anthropic_404: model not available for this key')];
    await handleConversationResolve(storage, interrupt, { operation: 'exchange', turn: { to: 'test.adr1016-answerer', content: LONG } }, async () => {});
    expect(calls).toEqual([BIG, OWN]);
    const events = await storage.listEvents('r-adr1016-prov');
    const agentTurn = events
      .filter((e) => e.type === 'conversation.exchanged')
      .map((e) => field(e.payload, 'turn'))
      .find((t) => field(t, 'role') === 'agent');
    expect(agentTurn, 'the agent turn was persisted').toBeDefined();
    expect(field(agentTurn, 'agent', 'model', 'model'), 'provenance names what ANSWERED').toBe(OWN);
  });
});

describe('ADR 1016 D4b — a routed model that cannot serve the key degrades ONCE', () => {
  const run: RunRecord = {
    runId: 'r-adr1016-degrade', workflowId: 'wf', tenantId: TENANT, status: 'running',
    inputs: BYOK, metadata: {}, configurable: {}, createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z',
  };
  const route = { provider: 'anthropic', model: BIG };

  it('routed model 404 → answered by the conversation\'s own model, and `served` says so', async () => {
    calls.length = 0;
    failures = [new Error('anthropic_404: model not available for this key')];
    const out = await dispatchReply(run, [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, undefined, route);
    expect(calls).toEqual([BIG, OWN]);
    expect(out.served).toEqual({ provider: 'anthropic', model: OWN });
  });

  it('CONTROL: with no route, the same 404 fails the turn (nothing chose the model, nothing to fall back to)', async () => {
    calls.length = 0;
    failures = [new Error('anthropic_404: model not available for this key')];
    await expect(dispatchReply(run, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/anthropic_404/);
    expect(calls).toEqual([OWN]);
  });
});
