/**
 * ADR 0459 P1+P3 — pack-half tests for the participant-replan lane:
 *   1. the plan-revision return schema (the Replan Composer's typed contract)
 *      validates each ADR 0429 lane, accepts the honest empty-commands result,
 *      and REJECTS extras / an unknown lane / a 6th command / a missing rationale;
 *   2. the two touched pack manifests parse and carry the P1/P3 wiring (the
 *      replan-composer agent's returnSchemaRef, the two new nodes, the bumps);
 *   3. `apply-revision-commands` registers, validates inputs, forwards the
 *      surface's failing command index on a typed refusal, and fails
 *      host_capability_missing without the governed surface;
 *   4. `session-reminder` registers, validates inputs, forwards the armed job's
 *      context to the session-notify op, and fails host_capability_missing
 *      without the surface.
 *
 * w41 grade-tests: the manifest cases used to pin exact version literals
 * (`1.9.1`, `1.30.3`) — a snapshot of a moment, chased on every bump. They now
 * assert the invariant: the shipped pack.json version IS the version
 * `kicktodo-core` pins in `requiredPacks` (replay determinism). Sabotages that
 * turn this file red: schema maxItems/minLength/closed-world edits, dropping
 * failedIndex forwarding, input validation, the conversationId spread, the
 * enrich best-effort catch, or the artifact type id.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { kicktodoCoreFeature } from '../src/features/kicktodo-core/feature.js';
import { featureRequiredPacks } from '../src/features/packPins.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '../../..');
const AGENTS_PACK = join(REPO_ROOT, 'packs/vendor.openwop-app.kicktodo.agents');
const NODES_PACK = join(REPO_ROOT, 'packs/feature.kicktodo.nodes');

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

interface AgentEntry { agentId: string; modelClass?: string; toolAllowlist?: string[]; handoff?: { returnSchemaRef?: string }; memoryShape?: { scratchpad: boolean; conversation: boolean; longTerm: boolean } }
interface AgentsPack { version: string; agents: AgentEntry[] }
interface NodesPack { version: string; nodes: Array<{ typeId: string; role?: string }> }
const readAgentsPack = (): AgentsPack => {
  const v: AgentsPack = JSON.parse(readFileSync(join(AGENTS_PACK, 'pack.json'), 'utf8'));
  return v;
};
const readNodesPack = (): NodesPack => {
  const v: NodesPack = JSON.parse(readFileSync(join(NODES_PACK, 'pack.json'), 'utf8'));
  return v;
};
/** The version kicktodo-core pins for a pack (the replay-determinism SSoT). */
const pinnedVersion = (name: string): string | undefined =>
  featureRequiredPacks(kicktodoCoreFeature).find((p) => p.name === name)?.version;

// ── 1. plan-revision return schema ────────────────────────────────────────
describe('plan-revision return schema (ADR 0459 P1)', () => {
  let validate: ValidateFunction;
  beforeAll(() => {
    const schema = readJson(join(AGENTS_PACK, 'schemas/plan-revision.schema.json'));
    if (!schema || typeof schema !== 'object') throw new Error('plan-revision schema is not an object');
    validate = new Ajv2020({ strict: false }).compile(schema);
  });

  it('accepts the schedule lane with each daypart and a cleared (null) preference', () => {
    for (const daypart of ['morning', 'afternoon', 'evening', null]) {
      expect(validate({ commands: [{ lane: 'schedule', daypart }], rationale: 'Move it later.' }), `daypart=${String(daypart)}`).toBe(true);
    }
  });

  it('accepts the substitute lane', () => {
    expect(validate({ commands: [{ lane: 'substitute', cardId: 'card-1', alternativeId: 'alt-2' }], rationale: 'Swap for the alternative.' })).toBe(true);
  });

  it('accepts the recovery lane', () => {
    expect(validate({ commands: [{ lane: 'recovery' }], rationale: 'Collapse the missed window.' })).toBe(true);
  });

  it('accepts the move lane (ADR 0496)', () => {
    expect(validate({ commands: [{ lane: 'move', day: 3, toDate: '2026-10-20' }], rationale: 'Move day 3.' })).toBe(true);
  });

  it('rejects a move with a non-ISO toDate or a day below 1', () => {
    expect(validate({ commands: [{ lane: 'move', day: 3, toDate: 'next tuesday' }], rationale: 'ok' })).toBe(false);
    expect(validate({ commands: [{ lane: 'move', day: 0, toDate: '2026-10-20' }], rationale: 'ok' })).toBe(false);
  });

  it('accepts an EMPTY commands array (the honest cannot-express result)', () => {
    expect(validate({ commands: [], rationale: 'That ask falls outside the schedule/substitution/recovery lanes.' })).toBe(true);
  });

  it('accepts up to five mixed-lane commands', () => {
    expect(validate({
      commands: [
        { lane: 'schedule', daypart: 'evening' },
        { lane: 'substitute', cardId: 'c1', alternativeId: 'a1' },
        { lane: 'recovery' },
        { lane: 'schedule', daypart: null },
        { lane: 'substitute', cardId: 'c2', alternativeId: 'a2' },
      ],
      rationale: 'A full week of adjustments.',
    })).toBe(true);
  });

  it('rejects a 6th command (maxItems 5)', () => {
    expect(validate({ commands: Array.from({ length: 6 }, () => ({ lane: 'recovery' })), rationale: 'Too many.' })).toBe(false);
  });

  it('rejects an unknown lane', () => {
    expect(validate({ commands: [{ lane: 'evidence-policy' }], rationale: 'Not a real lane.' })).toBe(false);
  });

  it('rejects a missing rationale', () => {
    expect(validate({ commands: [{ lane: 'recovery' }] })).toBe(false);
  });

  it('rejects an empty-string rationale', () => {
    expect(validate({ commands: [{ lane: 'recovery' }], rationale: '' })).toBe(false);
  });

  it('rejects an unknown top-level property (closed world)', () => {
    expect(validate({ commands: [{ lane: 'recovery' }], rationale: 'ok', extra: true })).toBe(false);
  });

  it('rejects an unknown property inside a lane command (closed world)', () => {
    expect(validate({ commands: [{ lane: 'schedule', daypart: 'morning', bogus: 1 }], rationale: 'ok' })).toBe(false);
    expect(validate({ commands: [{ lane: 'recovery', enrollmentId: 'e1' }], rationale: 'ok' })).toBe(false);
  });

  it('rejects a schedule command with a daypart outside the enum', () => {
    expect(validate({ commands: [{ lane: 'schedule', daypart: 'midnight' }], rationale: 'ok' })).toBe(false);
  });

  it('rejects a substitute command missing cardId or alternativeId', () => {
    expect(validate({ commands: [{ lane: 'substitute', cardId: 'c1' }], rationale: 'ok' })).toBe(false);
    expect(validate({ commands: [{ lane: 'substitute', alternativeId: 'a1' }], rationale: 'ok' })).toBe(false);
  });

  // ── XCH-KT-2 — pendingCommand is a lane-discriminated PARTIAL: only `lane`
  // is required (one slot legitimately unfilled), but the lane and per-lane
  // key set are CLOSED, so a typo'd key or invented lane fails at
  // composer-return time instead of only at apply-time validateCommand.
  const ask = (pendingCommand: unknown) => ({
    commands: [],
    rationale: 'Need one answer first.',
    clarification: {
      question: 'Which daypart?',
      field: { id: 'daypart', type: 'select', label: 'Daypart', options: ['morning', 'evening'] },
      pendingCommand,
    },
  });

  it('accepts a legitimate one-slot-missing partial in each lane (XCH-KT-2)', () => {
    expect(validate(ask({ lane: 'schedule' }))).toBe(true);
    expect(validate(ask({ lane: 'substitute', cardId: 'card-1' }))).toBe(true);
    expect(validate(ask({ lane: 'recovery' }))).toBe(true);
  });

  it('accepts a fully-filled pending command too (a partial is allowed, not required)', () => {
    expect(validate(ask({ lane: 'schedule', daypart: 'morning' }))).toBe(true);
  });

  it('rejects a pendingCommand with an unknown lane (XCH-KT-2)', () => {
    expect(validate(ask({ lane: 'evidence-policy' }))).toBe(false);
    expect(validate(ask({}))).toBe(false);
  });

  it("rejects a pendingCommand with a typo'd or foreign key (XCH-KT-2)", () => {
    expect(validate(ask({ lane: 'substitute', cardID: 'card-1' }))).toBe(false);
    expect(validate(ask({ lane: 'schedule', enrollmentId: 'e1' }))).toBe(false);
    expect(validate(ask({ lane: 'recovery', cardId: 'c1' }))).toBe(false);
  });

  it('rejects a pendingCommand with an out-of-enum slot value (XCH-KT-2)', () => {
    expect(validate(ask({ lane: 'schedule', daypart: 'midnight' }))).toBe(false);
  });
});

// ── 2. manifests parse + carry the P1/P3 wiring ───────────────────────────
describe('touched pack manifests (ADR 0459 P1+P3)', () => {
  it('agents pack is the version kicktodo-core pins, and the replan-composer returns the plan-revision schema (READ-only handoff skill)', () => {
    const pack = readAgentsPack();
    expect(pack.version).toBe(pinnedVersion('vendor.openwop-app.kicktodo.agents'));
    const agent = pack.agents.find((a) => a.agentId === 'vendor.openwop-app.kicktodo.agents.replan-composer');
    if (!agent) throw new Error('replan-composer must be declared');
    expect(agent.handoff?.returnSchemaRef).toBe('schemas/plan-revision.schema.json');
    // A handoff skill: scratchpad-only, no conversation memory, READ tools only.
    expect(agent.memoryShape).toEqual({ scratchpad: true, conversation: false, longTerm: false });
    expect(agent.toolAllowlist).toEqual(['openwop:kicktodo.today', 'openwop:kicktodo.progress']);
    expect(agent.modelClass).toBe('research');
  });

  it('nodes pack is the version kicktodo-core pins and declares the P1/P3 + grade-fix nodes', () => {
    const pack = readNodesPack();
    expect(pack.version).toBe(pinnedVersion('feature.kicktodo.nodes'));
    // KT-PACK-REPLAY-1 — the two WRITERS are side-effect (a fork is served the
    // recorded outcome; role:"action" earns nothing). The enrich read stays action.
    // Full classification: kicktodo-node-replay-classification.test.ts.
    const roles: Record<string, string> = {
      'feature.kicktodo.nodes.apply-revision-commands': 'side-effect',
      'feature.kicktodo.nodes.session-reminder': 'side-effect',
      'feature.kicktodo.nodes.enrich-plan-revision': 'action',
    };
    for (const [typeId, role] of Object.entries(roles)) {
      const node = pack.nodes.find((n) => n.typeId === typeId);
      expect(node?.role, `${typeId} must be declared ${role}`).toBe(role);
    }
  });
});

// ── 3 + 4. the two new nodes ──────────────────────────────────────────────
describe('participant-replan nodes (ADR 0459 P1+P3)', () => {
  type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string; failedIndex?: number } };
  type Ctx = Record<string, unknown>;
  type NodeFn = (ctx: Ctx) => Promise<NodeResult>;
  interface PackModule { nodes: Record<string, NodeFn>; applyRevisionCommands: NodeFn; sessionReminder: NodeFn; enrichPlanRevision: NodeFn }
  const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

  async function pack(): Promise<PackModule> {
    const m: PackModule = await import(packUrl);
    return m;
  }
  async function nodes(): Promise<Record<string, NodeFn>> {
    return (await pack()).nodes;
  }

  describe('apply-revision-commands', () => {
    const validInputs = { enrollmentId: 'enr-1', subject: 'user.a', commands: [{ lane: 'recovery' }] };

    // Twin: every behaviour case below also fails if the typeId is unregistered
    // (\`run is not a function\`); this case additionally pins the typeId to the
    // RIGHT implementation (a mis-wired registration passes the behaviour twins
    // only by accident).
    it('is registered in the pack under its typeId, bound to the applyRevisionCommands implementation', async () => {
      const m = await pack();
      expect(m.nodes['feature.kicktodo.nodes.apply-revision-commands']).toBe(m.applyRevisionCommands);
    });

    it('fails typed (host_capability_missing) when kicktodo-core is absent', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.apply-revision-commands'];
      await expect(run({ inputs: validInputs, features: {} }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    });

    it('fails typed (host_capability_missing) when core is present but applyRevisionCommands is not', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.apply-revision-commands'];
      await expect(run({ inputs: validInputs, features: { 'kicktodo-core': { enroll: async () => ({}) } } }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    });

    it('validates inputs (missing enrollmentId → typed validation_error)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.apply-revision-commands'];
      const features = { 'kicktodo-core': { enroll: async () => ({}), applyRevisionCommands: async () => ({ applied: true }) } };
      const out = await run({ inputs: { subject: 'user.a', commands: [] }, features });
      expect(out).toEqual({ status: 'failed', error: { code: 'validation_error', message: 'Input `enrollmentId` is required.' } });
    });

    it('forwards the surface refusal code AND the failing command index', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.apply-revision-commands'];
      const features = {
        'kicktodo-core': {
          enroll: async () => ({}),
          applyRevisionCommands: async () => { throw Object.assign(new Error('Unknown alternative.'), { code: 'validation_error', failedIndex: 2 }); },
        },
      };
      const out = await run({ inputs: validInputs, features });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('validation_error');
      expect(out.error?.failedIndex).toBe(2);
    });

    it('applies through the governed surface on the happy path', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.apply-revision-commands'];
      let received: Record<string, unknown> | undefined;
      const features = {
        'kicktodo-core': {
          enroll: async () => ({}),
          applyRevisionCommands: async (a: Record<string, unknown>) => { received = a; return { applied: true, results: [{ lane: 'recovery', ok: true }] }; },
        },
      };
      const out = await run({ inputs: validInputs, features });
      expect(out.status).toBe('success');
      expect(out.outputs?.applied).toBe(true);
      expect(received).toEqual({ enrollmentId: 'enr-1', subject: 'user.a', commands: [{ lane: 'recovery' }] });
    });
  });

  describe('session-reminder', () => {
    const validInputs = { circleId: 'circ-1', atIso: '2026-08-01T15:00:00.000Z', conversationId: 'conv-1' };

    // Twin: every behaviour case below also fails if the typeId is unregistered
    // (\`run is not a function\`); this case additionally pins the typeId to the
    // RIGHT implementation (a mis-wired registration passes the behaviour twins
    // only by accident).
    it('is registered in the pack under its typeId, bound to the sessionReminder implementation', async () => {
      const m = await pack();
      expect(m.nodes['feature.kicktodo.nodes.session-reminder']).toBe(m.sessionReminder);
    });

    it('fails typed (host_capability_missing) when kicktodo-accountability is absent', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.session-reminder'];
      await expect(run({ inputs: validInputs, features: {} }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    });

    it('fails typed (host_capability_missing) when accountability is present but sendSessionReminder is not', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.session-reminder'];
      await expect(run({ inputs: validInputs, features: { 'kicktodo-accountability': { feed: async () => ({}) } } }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    });

    it('validates inputs (missing atIso → typed validation_error)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.session-reminder'];
      const features = { 'kicktodo-accountability': { feed: async () => ({}), sendSessionReminder: async () => ({ notified: true }) } };
      const out = await run({ inputs: { circleId: 'circ-1' }, features });
      expect(out).toEqual({ status: 'failed', error: { code: 'validation_error', message: 'Input `atIso` is required.' } });
    });

    it('forwards the armed job context to the session-notify op', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.session-reminder'];
      let received: Record<string, unknown> | undefined;
      const features = {
        'kicktodo-accountability': {
          feed: async () => ({}),
          sendSessionReminder: async (a: Record<string, unknown>) => { received = a; return { notified: true }; },
        },
      };
      const out = await run({ inputs: validInputs, features });
      expect(out.status).toBe('success');
      expect(out.outputs?.notified).toBe(true);
      expect(received).toEqual({ circleId: 'circ-1', atIso: '2026-08-01T15:00:00.000Z', conversationId: 'conv-1' });
    });
  });

  describe('enrich-plan-revision (ADR 0459 grade-fix)', () => {
    const revision = { commands: [{ lane: 'recovery' }], rationale: 'Catch up.' };
    const validInputs = { enrollmentId: 'enr-1', revision };

    // Twin: every behaviour case below also fails if the typeId is unregistered
    // (\`run is not a function\`); this case additionally pins the typeId to the
    // RIGHT implementation (a mis-wired registration passes the behaviour twins
    // only by accident).
    it('is registered in the pack under its typeId, bound to the enrichPlanRevision implementation', async () => {
      const m = await pack();
      expect(m.nodes['feature.kicktodo.nodes.enrich-plan-revision']).toBe(m.enrichPlanRevision);
    });

    it('validates inputs (missing revision → typed validation_error)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.enrich-plan-revision'];
      const features = { 'kicktodo-core': { enroll: async () => ({}), enrichPlanRevision: async () => ({}) } };
      const out = await run({ inputs: { enrollmentId: 'enr-1' }, features });
      expect(out).toEqual({ status: 'failed', error: { code: 'validation_error', message: 'Input `revision` (the composed plan revision) is required.' } });
    });

    it('wraps the enriched revision as a TYPED kicktodo.plan-revision artifact envelope', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.enrich-plan-revision'];
      let received: Record<string, unknown> | undefined;
      const enriched = { ...revision, display: { summary: '1 change to your plan', lines: ['Collapse your missed activities into a single recovery day.'] } };
      const features = {
        'kicktodo-core': {
          enroll: async () => ({}),
          enrichPlanRevision: async (a: Record<string, unknown>) => { received = a; return { revision: enriched }; },
        },
      };
      const out = await run({ inputs: validInputs, features });
      expect(out.status).toBe('success');
      expect(received).toEqual({ enrollmentId: 'enr-1', revision });
      // display carried; commands untouched
      expect(out.outputs?.result).toEqual({ artifactTypeId: 'kicktodo.plan-revision', payload: enriched });
    });

    it('best-effort: a THROWING enrich surface degrades to the un-humanized typed payload (never fails the run)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.enrich-plan-revision'];
      const features = {
        'kicktodo-core': {
          enroll: async () => ({}),
          enrichPlanRevision: async () => { throw new Error('today read failed'); },
        },
      };
      const out = await run({ inputs: validInputs, features });
      expect(out.status).toBe('success');
      // raw payload, still typed → card renders
      expect(out.outputs?.result).toEqual({ artifactTypeId: 'kicktodo.plan-revision', payload: revision });
    });

    it('best-effort: a MISSING enrich surface still emits the typed payload (no display)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.enrich-plan-revision'];
      const out = await run({ inputs: validInputs, features: { 'kicktodo-core': { enroll: async () => ({}) } } });
      expect(out.status).toBe('success');
      expect(out.outputs?.result).toEqual({ artifactTypeId: 'kicktodo.plan-revision', payload: revision });
    });
  });
});
