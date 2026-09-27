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
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '../../..');
const AGENTS_PACK = join(REPO_ROOT, 'packs/feature.kicktodo.agents');
const NODES_PACK = join(REPO_ROOT, 'packs/feature.kicktodo.nodes');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ── 1. plan-revision return schema ────────────────────────────────────────
describe('plan-revision return schema (ADR 0459 P1)', () => {
  let validate: (v: unknown) => boolean;
  beforeAll(async () => {
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as { default: new (o?: unknown) => { compile: (s: unknown) => (v: unknown) => boolean } };
    const schema = readJson(join(AGENTS_PACK, 'schemas/plan-revision.schema.json'));
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
  it('agents pack is at 1.9.0 and the replan-composer returns the plan-revision schema (READ-only handoff skill)', () => {
    const pack = readJson(join(AGENTS_PACK, 'pack.json'));
    expect(pack.version).toBe('1.9.0');
    const agent = pack.agents.find((a: { agentId: string }) => a.agentId === 'feature.kicktodo.agents.replan-composer');
    expect(agent, 'replan-composer must be declared').toBeDefined();
    expect(agent.handoff?.returnSchemaRef).toBe('schemas/plan-revision.schema.json');
    // A handoff skill: scratchpad-only, no conversation memory, READ tools only.
    expect(agent.memoryShape).toEqual({ scratchpad: true, conversation: false, longTerm: false });
    expect(agent.toolAllowlist).toEqual(['openwop:kicktodo.today', 'openwop:kicktodo.progress']);
    expect(agent.modelClass).toBe('research');
  });

  it('nodes pack is at 1.30.0 and declares the P1/P3 + grade-fix action nodes', () => {
    const pack = readJson(join(NODES_PACK, 'pack.json'));
    expect(pack.version).toBe('1.30.0');
    for (const typeId of [
      'feature.kicktodo.nodes.apply-revision-commands',
      'feature.kicktodo.nodes.session-reminder',
      'feature.kicktodo.nodes.enrich-plan-revision',
    ]) {
      const node = pack.nodes.find((n: { typeId: string }) => n.typeId === typeId);
      expect(node, `${typeId} must be declared`).toBeDefined();
      expect(node.role).toBe('action');
    }
  });
});

// ── 3 + 4. the two new nodes ──────────────────────────────────────────────
describe('participant-replan nodes (ADR 0459 P1+P3)', () => {
  type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string; failedIndex?: number } };
  type Ctx = Record<string, unknown>;
  const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

  async function nodes(): Promise<Record<string, (ctx: Ctx) => Promise<NodeResult>>> {
    const m = (await import(packUrl)) as { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> };
    return m.nodes;
  }

  describe('apply-revision-commands', () => {
    const validInputs = { enrollmentId: 'enr-1', subject: 'user.a', commands: [{ lane: 'recovery' }] };

    it('is registered in the pack', async () => {
      expect(typeof (await nodes())['feature.kicktodo.nodes.apply-revision-commands']).toBe('function');
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
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('validation_error');
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

    it('is registered in the pack', async () => {
      expect(typeof (await nodes())['feature.kicktodo.nodes.session-reminder']).toBe('function');
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
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('validation_error');
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

    it('is registered in the pack', async () => {
      expect(typeof (await nodes())['feature.kicktodo.nodes.enrich-plan-revision']).toBe('function');
    });

    it('validates inputs (missing revision → typed validation_error)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.enrich-plan-revision'];
      const features = { 'kicktodo-core': { enroll: async () => ({}), enrichPlanRevision: async () => ({}) } };
      const out = await run({ inputs: { enrollmentId: 'enr-1' }, features });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('validation_error');
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
      const result = out.outputs?.result as { artifactTypeId?: string; payload?: unknown };
      expect(result.artifactTypeId).toBe('kicktodo.plan-revision');
      expect(result.payload).toEqual(enriched); // display carried; commands untouched
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
      const result = out.outputs?.result as { artifactTypeId?: string; payload?: unknown };
      expect(result.artifactTypeId).toBe('kicktodo.plan-revision');
      expect(result.payload).toEqual(revision); // raw payload, still typed → card renders
    });

    it('best-effort: a MISSING enrich surface still emits the typed payload (no display)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.enrich-plan-revision'];
      const out = await run({ inputs: validInputs, features: { 'kicktodo-core': { enroll: async () => ({}) } } });
      expect(out.status).toBe('success');
      const result = out.outputs?.result as { artifactTypeId?: string; payload?: unknown };
      expect(result.artifactTypeId).toBe('kicktodo.plan-revision');
      expect(result.payload).toEqual(revision);
    });
  });
});
