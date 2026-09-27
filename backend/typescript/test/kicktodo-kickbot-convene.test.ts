/**
 * ADR 0442 P5 — KickBot CONVENES a bounded specialist handoff skill (live).
 *
 * Two steps, the endorsed orchestrator-worker split:
 *  1. a SYNC contract-check via the shared deterministic `runAgentDispatch` (no
 *     model, no credential) — validates the handoff task + confirms the read-only
 *     tool confinement BEFORE spending a live turn;
 *  2. LIVE convening (async post-back) — a fire-now one-shot scheduler job running
 *     the convene turn-workflow, which runs the specialist LIVE on the managed tier
 *     and posts its advice back into KickBot's conversation (the schedule-followup
 *     seam — a chat tool can reach the scheduler, not the run-starter).
 *
 * The specialist's read-only allowlist confines both steps, so a convened
 * specialist can never write domain state. The pack isn't installed in this unit
 * test, so we register synthetic specialists (the real pack agentIds) with a
 * handoff validator + read-only allowlist; a separate block drives the REAL loader.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatch } from '../src/host/agentDispatch.js';
import { listJobsForSubject } from '../src/host/schedulingService.js';
import { resolveAgentToolAllowlistOverride, effectiveToolAllowlist, DEFAULT_ON_AGENT_TOOL_IDS } from '../src/host/agentToolAllowlistService.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { conveneSpecialist, convenableSpecialists } from '../src/features/kicktodo-core/agentTools.js';
import { KICKTODO_CONVENE_TURN_WORKFLOW_ID, KICKTODO_CONVENE_CREDENTIAL_REF, seedKicktodoConveneTurnWorkflow } from '../src/features/kicktodo-core/conveneTurnWorkflow.js';

const T = 'tenant-convene';
const PLAN_BUILDER = 'feature.kicktodo.agents.plan-builder';
const ACTOR = { tenantId: T, actingUserId: 'user:u1', agentProfileId: 'host:kickbot', conversationId: 'conv-1' };
const KICKTODO_AGENTS_PACK = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'packs', 'feature.kicktodo.agents');

function registerSpecialist(agentId: string, toolAllowlist: string[] = ['openwop:kicktodo.today', 'openwop:kicktodo.progress']): void {
  getAgentRegistry().register({
    agentId,
    persona: 'RESEARCH',
    modelClass: 'research',
    systemPrompt: 'test specialist',
    packName: 'feature.kicktodo.agents',
    packVersion: '1.3.0',
    toolAllowlist,
    confidence: { defaultThreshold: 0.6 },
    memoryShape: { scratchpad: true, conversation: false, longTerm: false },
    // The typed handoff contract: a task MUST carry a non-empty `goal`.
    handoff: {
      validateTask: (v: unknown) => {
        const goal = (v as { goal?: unknown } | null)?.goal;
        return typeof goal === 'string' && goal.length > 0 ? { ok: true } : { ok: false, errors: 'goal is required' };
      },
    },
  });
}

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-convene-')) });
  initHostExtPersistence(await openStorage('memory://'));
  seedKicktodoConveneTurnWorkflow();
  getAgentRegistry()._resetForTest();
});
afterEach(() => {
  __resetHostExtPersistence();
  getAgentRegistry()._resetForTest();
});

const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, any>;

describe('KickBot convenes a specialist (ADR 0442 P5)', () => {
  it('validates the contract, fires a LIVE run of the specialist, and posts back into the conversation', async () => {
    registerSpecialist(PLAN_BUILDER);
    const r = await conveneSpecialist({ specialist: 'plan-builder', goal: 'draft a 5-day plan' }, ACTOR);
    expect(r.isError).toBeUndefined();
    const rec = parse(r);
    expect(rec.status).toBe('convened');
    expect(rec.specialist).toBe('plan-builder');
    expect(rec.provenance.parentAgentId).toBe('host:kickbot'); // attributed to the convener (David's-law: from scope)
    expect(rec.provenance.specialistVersion).toBe('1.3.0');
    expect(rec).not.toHaveProperty('recommendations'); // honest — no fabricated advice in the tool return
    expect(rec.note).toMatch(/reviewing now|post into this conversation/i);

    // The LIVE run is a fire-now job firing the convene turn-workflow, as the
    // SPECIALIST, on the managed tier, posting back into THIS conversation.
    const jobs = await listJobsForSubject(T, { kind: 'user', id: 'user:u1' });
    const convened = jobs.find((j) => j.metadata?.['tool'] === 'openwop:kicktodo.convene');
    expect(convened).toBeDefined();
    expect(convened!.workflowId).toBe(KICKTODO_CONVENE_TURN_WORKFLOW_ID);
    expect(convened!.agentId).toBe(PLAN_BUILDER);
    expect(convened!.configurable?.['agentId']).toBe(PLAN_BUILDER);
    expect(convened!.configurable?.['conversationId']).toBe('conv-1');
    expect(convened!.configurable?.['credentialRef']).toBe(KICKTODO_CONVENE_CREDENTIAL_REF); // managed — no BYOK
  });

  it('a task that violates the handoff contract is a TYPED failure — NOTHING is run', async () => {
    registerSpecialist(PLAN_BUILDER);
    const r = await conveneSpecialist({ specialist: 'plan-builder', goal: '' }, ACTOR);
    expect(r.isError).toBe(true);
    const rec = parse(r);
    expect(rec.status).toBe('failed');
    expect(rec.error.code).toBe('task_schema_violation'); // the real, validated contract — not a vacuous {ok:true}
    // No live run was scheduled on a failed contract.
    const jobs = await listJobsForSubject(T, { kind: 'user', id: 'user:u1' });
    expect(jobs.some((j) => j.metadata?.['tool'] === 'openwop:kicktodo.convene')).toBe(false);
  });

  it('with NO conversation to post into, fails SOFT to the validated contract (no run)', async () => {
    registerSpecialist(PLAN_BUILDER);
    const r = await conveneSpecialist({ specialist: 'plan-builder', goal: 'x' }, { tenantId: T, actingUserId: 'user:u1', agentProfileId: 'host:kickbot' });
    expect(r.isError).toBeUndefined();
    expect(parse(r).status).toBe('validated'); // contract validated; nothing scheduled
    const jobs = await listJobsForSubject(T, { kind: 'user', id: 'user:u1' });
    expect(jobs.some((j) => j.metadata?.['tool'] === 'openwop:kicktodo.convene')).toBe(false);
  });

  it('SYNC check: a write/egress tool is filtered out by the read-only allowlist', () => {
    registerSpecialist(PLAN_BUILDER, ['openwop:kicktodo.today']); // read-only
    const r = runAgentDispatch({
      agentId: PLAN_BUILDER,
      task: { goal: 'x' },
      availableTools: ['openwop:kicktodo.today', 'openwop:kicktodo.WRITE-plan', 'openwop:danger.egress'],
      validateHandoff: true,
    });
    expect(r.toolSurface).toEqual(['openwop:kicktodo.today']); // write/egress filtered OUT
  });

  it('LIVE run is CONFINED — convene sets a full-replace override that EXCLUDES the ADR 0315 write/egress/recursion baseline', async () => {
    const readOnly = ['openwop:kicktodo.today', 'openwop:kicktodo.progress'];
    registerSpecialist(PLAN_BUILDER, readOnly);
    await conveneSpecialist({ specialist: 'plan-builder', goal: 'draft a plan' }, ACTOR);

    // The override the convene set for the specialist = its read-only allowlist.
    const override = await resolveAgentToolAllowlistOverride(T, PLAN_BUILDER);
    expect(override).toEqual(readOnly);

    // WITH the override, the LIVE offering (effectiveToolAllowlist) is EXACTLY the
    // read-only set — every write/egress/recursion baseline tool is EXCLUDED.
    const live = effectiveToolAllowlist(readOnly, override);
    for (const baseline of DEFAULT_ON_AGENT_TOOL_IDS) expect(live).not.toContain(baseline);
    expect([...live].sort()).toEqual([...readOnly].sort()); // exactly the read tools, nothing else

    // NON-VACUITY: WITHOUT the override, the baseline WOULD be unioned in — proving
    // the override is load-bearing (a convened specialist would otherwise get live
    // web egress + write tools + the schedule-followup recursion vector).
    const unconfined = effectiveToolAllowlist(readOnly, undefined);
    expect(unconfined).toContain('openwop:ai.research.web');
    expect(unconfined).toContain('openwop:kanban.add-todo');
    expect(unconfined).toContain('openwop:tasks.schedule-followup');
  });

  it('rejects an unknown specialist (closed allowlist), never a free-form agentId', async () => {
    registerSpecialist(PLAN_BUILDER);
    const r = await conveneSpecialist({ specialist: 'feature.evil.agents.exfiltrator', goal: 'x' }, ACTOR);
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('unknown_specialist');
  });

  it('fails empty without an acting user (a system turn cannot convene over a participant)', async () => {
    registerSpecialist(PLAN_BUILDER);
    const r = await conveneSpecialist({ specialist: 'plan-builder', goal: 'x' }, { tenantId: T, agentProfileId: 'host:kickbot' });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('acting_user_required');
  });

  it('an uninstalled specialist is an honest typed error, not a throw', async () => {
    registerSpecialist(PLAN_BUILDER); // safety-reviewer is NOT registered
    const r = await conveneSpecialist({ specialist: 'safety-reviewer', goal: 'x' }, ACTOR);
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('specialist_unavailable');
  });

  it('bounds fan-out — refuses once the participant already has the max pending convened specialists', async () => {
    for (const s of ['plan-builder', 'safety-reviewer', 'progress-verifier', 'accountability-steward']) {
      registerSpecialist(`feature.kicktodo.agents.${s}`);
    }
    // 5 distinct convenes (distinct goals ⇒ distinct jobIds) fill the cap.
    for (let i = 0; i < 5; i++) {
      const r = await conveneSpecialist({ specialist: 'plan-builder', goal: `plan ${i}` }, ACTOR);
      expect(parse(r).status).toBe('convened');
    }
    const sixth = await conveneSpecialist({ specialist: 'safety-reviewer', goal: 'one more' }, ACTOR);
    expect(sixth.isError).toBe(true);
    expect(parse(sixth).error).toBe('too_many_convenes');
  });
});

/**
 * The REAL pack must LOAD through `loadAgentsFromManifest` (the production loader:
 * `Ajv2020` compiles each handoff schema at load and SKIPS an agent whose schema
 * won't compile). A JSON-parse-only parity check masks a schema the loader can't
 * load (draft-07 `$schema`, colliding `$id`) — so this drives the real loader end
 * to end and convenes a REAL-loaded specialist. Non-vacuous: it fails if any
 * specialist fails to load (the exact P5 code-review defect).
 */
describe('the convenable specialists LOAD through the real pack loader', () => {
  beforeEach(() => {
    getAgentRegistry()._resetForTest();
    loadAgentsFromManifest(KICKTODO_AGENTS_PACK); // registers every loadable agent
  });
  afterEach(() => { getAgentRegistry()._resetForTest(); });

  it('all 4 convenable specialists load with COMPILED handoff validators', () => {
    for (const short of convenableSpecialists()) {
      const agent = getAgentRegistry().get(`feature.kicktodo.agents.${short}`);
      expect(agent, `${short} loaded from the pack`).toBeTruthy();
      expect(typeof agent!.handoff?.validateTask, `${short} has a compiled task validator`).toBe('function');
      expect(typeof agent!.handoff?.validateReturn, `${short} has a compiled return validator`).toBe('function');
      for (const tool of agent!.toolAllowlist ?? []) expect(tool.startsWith('openwop:kicktodo.')).toBe(true);
    }
  });

  it('convenes a REAL-loaded specialist end-to-end → convened; a bad task is a real typed failure', async () => {
    const ok = await conveneSpecialist({ specialist: 'plan-builder', goal: 'draft a plan' }, ACTOR);
    expect(ok.isError).toBeUndefined();
    expect(parse(ok).status).toBe('convened'); // the REAL compiled task+return validators accepted it

    const bad = await conveneSpecialist({ specialist: 'plan-builder', goal: '' }, ACTOR);
    expect(bad.isError).toBe(true);
    expect(parse(bad).error.code).toBe('task_schema_violation'); // the REAL pack schema validates
  });
});
