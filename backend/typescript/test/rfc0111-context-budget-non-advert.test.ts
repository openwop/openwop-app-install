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
 *
 * Round 2 (8fw1g4): leg 1 could not fail. It read `multiAgentExecution` (the v1
 * spelling) off a booted host whose default env advertises NO multi-agent family at
 * all, so an injected `contextBudget` was invisible (probe cb-advert, vacuous). It now
 * builds the v2 document with the family ON at v5 (as prod runs), asserts the family
 * is present (positive control), then asserts the absence on it. No app boot.
 *
 * Sabotages that red this file: advertising `contextBudget` on the v2 multiAgent
 * family, flipping SUPERVISOR_CALLS_LIVE_MODEL, a supervisor that reaches `callAI`,
 * and a supervisor that does not echo its config plan.
 */
import { describe, expect, it } from 'vitest';
import { ensureNodesRegistered, SUPERVISOR_CALLS_LIVE_MODEL } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import type { AppConfig } from '../src/index.js';

const CONFIG: AppConfig = {
  port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false,
};

/** The multi-agent phase gates prod runs with (executionModel v5). */
const PHASE_ENV = [
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5',
] as const;

describe('RFC 0111 — contextBudget is withheld while the orchestrator is a mock', () => {
  it('leg 1: the v2 advertisement (multiAgent family ON, v5) states NO contextBudget or transcriptWindow', () => {
    const prev = PHASE_ENV.map((k) => [k, process.env[k]] as const);
    for (const k of PHASE_ENV) process.env[k] = 'true';
    try {
      const doc = buildV2Advertisement(CONFIG);
      // Positive control — without the family the absence below means nothing.
      expect(doc['multiAgent'], 'the multiAgent family must be advertised for this leg to bite').toMatchObject({
        executionModel: { version: 5 },
      });
      const text = JSON.stringify(doc);
      expect(text, 'RFC 0111 §Scope — MUST NOT advertise contextBudget without real orchestrator model turns').not.toContain('contextBudget');
      expect(text, 'RFC 0061 — same honesty condition as contextBudget').not.toContain('transcriptWindow');
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
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

    // ADR 0858 P3 — tied to the ONE fact (`SUPERVISOR_CALLS_LIVE_MODEL`, nodes.ts),
    // which also gates the live-model fixtures in `fixtures[]`. A supervisor that
    // starts calling a model reds here until that fact is flipped deliberately.
    expect(modelTurnAttempted, 'SUPERVISOR_CALLS_LIVE_MODEL must match whether the supervisor reaches callAI (RFC 0111 §Scope + ADR 0858 P3)').toBe(SUPERVISOR_CALLS_LIVE_MODEL);
    expect(SUPERVISOR_CALLS_LIVE_MODEL, 'RFC 0111 §Scope — a supervisor that runs real model turns changes the advert decision').toBe(false);
    expect(out.status).toBe('success');
    if (out.status !== 'success') return; // narrows the NodeOutcome union
    // Byte-identical echo of config input: the plan came from config, not from a model.
    const outputs: Record<string, unknown> = { ...(out.outputs ?? {}) };
    expect(outputs['decisions'], 'mock supervisor echoes config; a real one would not').toEqual(plan);
  });
});
