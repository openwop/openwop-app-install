/**
 * ADR 0414 P4 — the SSoT tripwires for the KickTodo model-facing surface:
 *
 *  1. ARTIFACT PARITY: the registered `kicktodo.progress-evidence` schema is
 *     TEST-PINNED to its producer — a REAL frozen snapshot must validate
 *     (schema text drifting from the producer = red test, not a lie to a model).
 *  2. PROMPT DISCIPLINE (the catalogParity INVERSION): skill prompts must NOT
 *     hand-copy node typeIds or schema field lists — grounding is tool-first;
 *     the only ids a prompt may lean on are its allowlisted tools.
 *  3. Pack pins: feature.requiredPacks versions match the shipped pack.json
 *     versions (a pack bump without a pin bump breaks replay determinism).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { validateArtifact } from '../src/host/artifactTypes.js';
import { registerKicktodoArtifactTypes, PROGRESS_EVIDENCE_TYPE, PLAN_REVISION_TYPE } from '../src/features/kicktodo-core/artifactSchemas.js';
import { buildPlanRevisionDisplay } from '../src/features/kicktodo-core/replanService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll } from '../src/features/kicktodo-core/enrollmentService.js';
import { freezeProgressEvidence } from '../src/features/kicktodo-core/progressService.js';
import { kicktodoCoreFeature } from '../src/features/kicktodo-core/feature.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const TENANT = 'tenant-parity';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerKicktodoArtifactTypes();
});

describe('artifact schema ↔ producer parity', () => {
  it('a REAL frozen snapshot validates against the registered schema', async () => {
    const draft = await createDraft({
      tenantId: TENANT,
      title: 'Parity probe',
      summary: 's',
      outcome: 'o',
      durationDays: 1,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'T', instructions: '', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(TENANT, draft.id, 1);
    const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: 'user:parity', challengeId: draft.id, challengeVersion: 1 });
    const snapshot = await freezeProgressEvidence(TENANT, enrollment.id);
    const v = validateArtifact(PROGRESS_EVIDENCE_TYPE, snapshot as unknown as Record<string, unknown>);
    expect(v.registered).toBe(true);
    expect(v.valid, JSON.stringify(v.errors)).toBe(true);
  });

  // ADR 0459 grade-fix — the plan-revision card is a TYPED artifact, so its payload
  // (including the additive `display`) must validate against the registered schema, or
  // `detectTypedArtifact` falls back to raw JSON (the exact bug this fixes).
  it('a plan-revision payload validates WITH and WITHOUT the additive display', async () => {
    const raw = { commands: [{ lane: 'recovery' }], rationale: 'Catch up.' } as Record<string, unknown>;
    const withoutDisplay = validateArtifact(PLAN_REVISION_TYPE, raw);
    expect(withoutDisplay.registered).toBe(true);
    expect(withoutDisplay.valid, JSON.stringify(withoutDisplay.errors)).toBe(true);
    // The enricher's real output (display resolved from an empty state → neutral lines).
    const display = await buildPlanRevisionDisplay(TENANT, 'enr:none', raw);
    const enriched = validateArtifact(PLAN_REVISION_TYPE, { ...raw, display });
    expect(enriched.valid, JSON.stringify(enriched.errors)).toBe(true);
    expect(display.lines).toHaveLength(1); // one command → one humanized line, never an id
    expect(JSON.stringify(display)).not.toContain('enr:none');
  });
});

describe('prompt discipline (tool-first, no hand-copied schemas)', () => {
  const pack = JSON.parse(readFileSync(join(REPO, 'packs/feature.kicktodo.agents/pack.json'), 'utf8')) as {
    agents: Array<{ agentId: string; systemPromptRef: string; toolAllowlist: string[]; memoryShape?: { scratchpad: boolean; conversation: boolean; longTerm: boolean } }>;
  };
  it('no skill prompt names node typeIds or artifact type ids', () => {
    for (const a of pack.agents) {
      const prompt = readFileSync(join(REPO, 'packs/feature.kicktodo.agents', a.systemPromptRef), 'utf8');
      expect(prompt).not.toMatch(/feature\.kicktodo\.nodes\./);
      expect(prompt).not.toMatch(/kicktodo\.progress-evidence|kicktodo\.completion-certificate/);
      expect(prompt).not.toMatch(/snapshotHash|challengeContentHash/); // schema fields stay out of prose
    }
  });
  it('memory shape is scratchpad-only for every handoff skill (the conversational Challenge Author is exempt — ADR 0458)', () => {
    // ADR 0458 introduced the FIRST conversational named agent into this pack —
    // the Challenge Author talks a creator through a concept in the ONE chat, so
    // it carries CONVERSATION memory by design and is not a scratchpad-only
    // handoff skill. Every OTHER agent stays a handoff skill (scratchpad-only).
    const CONVERSATIONAL = 'feature.kicktodo.agents.challenge-author';
    for (const a of pack.agents) {
      if (a.agentId === CONVERSATIONAL) {
        expect(a.memoryShape).toEqual({ scratchpad: true, conversation: true, longTerm: false });
        continue;
      }
      expect(a.memoryShape).toEqual({ scratchpad: true, conversation: false, longTerm: false });
    }
  });
});

describe('pack pins', () => {
  it('feature.requiredPacks versions match the shipped pack.json versions', () => {
    for (const pin of kicktodoCoreFeature.requiredPacks ?? []) {
      const shipped = JSON.parse(readFileSync(join(REPO, 'packs', pin.name, 'pack.json'), 'utf8')) as { version: string };
      expect(shipped.version, pin.name).toBe(pin.version);
    }
    expect((kicktodoCoreFeature.requiredPacks ?? []).length).toBeGreaterThan(0);
  });
});
