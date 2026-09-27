/**
 * RFC 0111 §"Context economy" — the DELIBERATE non-advert, pinned.
 *
 * `spec/v1/multi-agent-execution.md` (normative): *"A host whose multi-agent
 * orchestrator loop does not run real model turns (e.g. a mock supervisor with
 * no live inference) MUST NOT advertise `contextBudget`, exactly as it MUST NOT
 * dishonestly advertise `transcriptWindow`."* The same section scopes
 * `contextBudget` to the RFC 0061 per-iteration ORCHESTRATOR transcript —
 * explicitly NOT a chat-conversation history (RFC 0005) or any other prompt.
 *
 * This host's orchestrator supervisor is the conformance-MOCK form: it echoes a
 * config-supplied `mockDispatchPlan` and runs no inference. So the advert is
 * withheld, on purpose.
 *
 * WHY THIS FILE EXISTS — it is a retrieval fix, not a fourth prose note.
 * That disposition was already recorded in three places: `host/transcriptBudget.ts`'s
 * scope note, ADR 0148's Phase-3 correction note, and the upstream spec session's
 * own register. It was nonetheless re-opened on 2026-08-09 as "in-flight host
 * work" — the claim reached a peer session before verification caught it. The
 * information was not missing; nobody retrieved it. Prose that records a decision
 * cannot fail, so it decays silently; a test can, so it does not.
 *
 * NOT A PERMANENT VETO. Leg 2 states the PREMISE (the supervisor is a mock) as an
 * assertion of its own. Ship a supervisor that runs real model turns and leg 2
 * goes red — which is the signal to revisit the advert deliberately, with
 * `contextBudget`'s honesty conditions re-read, rather than to delete this file.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';
import { createApp } from '../src/index.js';

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Every place a capability family can legally appear: RFC 0073 document root, plus
 *  the deprecated `capabilities` wrapper this host still mirrors for the v1.x window. */
const surfaces = (doc: Record<string, unknown>): Record<string, unknown>[] => {
  const wrapper = doc['capabilities'];
  return [doc, ...(wrapper && typeof wrapper === 'object' ? [wrapper as Record<string, unknown>] : [])];
};

describe('RFC 0111 — contextBudget is withheld while the orchestrator is a mock', () => {
  it('leg 1: /.well-known/openwop advertises NO contextBudget on any surface', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    const doc = (await res.json()) as Record<string, unknown>;

    for (const surface of surfaces(doc)) {
      const mae = surface['multiAgentExecution'];
      if (mae && typeof mae === 'object') {
        const fields = mae as Record<string, unknown>;
        expect(fields['contextBudget'], 'RFC 0111 §Scope — MUST NOT advertise contextBudget without real orchestrator model turns').toBeUndefined();
        expect(fields['transcriptWindow'], 'RFC 0061 — same honesty condition as contextBudget').toBeUndefined();
      }
      // Dotted spellings, in case a future advert lands on the migration arm.
      expect(surface['multiAgentExecution.contextBudget'], 'dotted spelling must not smuggle the advert in').toBeUndefined();
      expect(surface['host.multiAgentExecution'], 'prefixed spelling must not smuggle the advert in').toBeUndefined();
    }
  });

  it('leg 2: the PREMISE — core.orchestrator.supervisor runs NO model turn (a poisoned callAI is never reached)', async () => {
    ensureNodesRegistered();
    const supervisor = getNodeRegistry().get('core.orchestrator.supervisor');
    if (!supervisor) throw new Error('core.orchestrator.supervisor must be registered');

    // A plan no model would ever produce. A mock echoes it verbatim; a real
    // supervisor emits its own decision per invocation (nodes.ts §RFC 0022 §A).
    const plan = [
      { kind: 'next-worker', nextWorkerIds: ['sentinel-worker-rfc0111'] },
      { kind: 'terminate', reason: 'goal-reached' },
    ];

    // The load-bearing part of this leg: `NodeContext.callAI` is the ONLY seam a
    // node has for a model turn, and it is optional. Poison it. If the supervisor
    // ever becomes a real orchestrator loop, it reaches this and the leg goes red
    // by construction — no reliance on output-shape heuristics.
    let modelTurnAttempted = false;
    const emitted: string[] = [];
    const ctx: NodeContext = {
      runId: 'run-rfc0111', nodeId: 'sup', tenantId: 'tenant-rfc0111',
      inputs: {}, config: { mockDispatchPlan: plan }, configurable: {}, attempt: 1,
      secrets: {},
      async emit(type: string) { emitted.push(type); return { eventId: `ev-${emitted.length}`, sequence: emitted.length }; },
      callAI: () => { modelTurnAttempted = true; throw new Error('leg 2: the supervisor attempted a real model turn'); },
    };
    const out = await supervisor.execute(ctx);

    expect(modelTurnAttempted, 'RFC 0111 §Scope — a supervisor that runs real model turns changes the advert decision').toBe(false);
    expect(out.status).toBe('success');
    if (out.status !== 'success') return; // narrows the NodeOutcome union
    // Byte-identical echo of config input: the plan came from config, not from a model.
    const outputs: Record<string, unknown> = { ...(out.outputs ?? {}) };
    expect(outputs['decisions'], 'mock supervisor echoes config; a real one would not').toEqual(plan);
  });
});
