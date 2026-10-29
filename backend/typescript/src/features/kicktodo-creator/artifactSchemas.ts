/**
 * kicktodo.challenge-plan artifact type (ADR 0415 P2) — the cross-workflow
 * plan contract, registered with the ONE host artifact registry and
 * DRIFT-PINNED to the producer (`kicktodo-creator-plan.test.ts` validates a
 * real valid plan against it). AI generation composes this schema through the
 * structured-output seam; acceptance always passes `validatePlan` (the
 * deterministic gate) regardless of what the model returned.
 */

import { registerArtifactType } from '../../host/artifactTypes.js';
import { LESSON_JSON_SCHEMA } from './lessonAssembly.js';
import { CHALLENGE_PLAN_JSON_SCHEMA } from './planService.js';

export const CHALLENGE_PLAN_TYPE = 'kicktodo.challenge-plan';

/** XCH-GATE-1 / XCH-LB-3 — what a lesson checkpoint gate shows its approver:
 *  each built lesson beside the plan row it was built from, with its image when
 *  media was generated. Produced by the `lesson-batch-build` node and routed to
 *  gate-0..3 through the run bag. Each lesson's shape is LESSON_JSON_SCHEMA (the
 *  SSoT the node validates against) plus the two facets the gate adds. */
export const CHALLENGE_LESSON_BATCH_TYPE = 'kicktodo.challenge-lesson-batch';

export const CHALLENGE_LESSON_BATCH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['lessons', 'count', 'mediaCount'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...LESSON_JSON_SCHEMA.required, 'plan'],
        properties: {
          ...LESSON_JSON_SCHEMA.properties,
          mediaAssetId: { type: 'string', minLength: 1 },
          plan: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'actionInstruction', 'userFacingWhy'],
            properties: {
              title: { type: 'string' },
              actionInstruction: { type: 'string' },
              userFacingWhy: { type: 'string' },
            },
          },
        },
      },
    },
    count: { type: 'integer', minimum: 0 },
    mediaCount: { type: 'integer', minimum: 0 },
  },
} as const;

export function registerKicktodoCreatorArtifactTypes(): void {
  registerArtifactType({
    artifactTypeId: CHALLENGE_PLAN_TYPE,
    title: 'KickTodo challenge plan',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['title', 'promise', 'audience', 'durationDays', 'dailyMinutesBudget', 'outcomes', 'achievements', 'days'],
      properties: {
        title: { type: 'string', minLength: 1 },
        promise: { type: 'string' },
        audience: { type: 'string' },
        durationDays: { type: 'integer', minimum: 3, maximum: 60 },
        dailyMinutesBudget: { type: 'number', minimum: 5, maximum: 120 },
        // ADR 0443 R4 — optional depth facet (Discover filter); absent = unlabeled.
        depthLevel: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        outcomes: {
          type: 'array', minItems: 1,
          items: { type: 'object', additionalProperties: false, required: ['outcomeId', 'measurableOutcome', 'method'],
            properties: { outcomeId: { type: 'string' }, measurableOutcome: { type: 'string' }, method: { type: 'string' } } },
        },
        achievements: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['achievementId', 'observableEvidence', 'outcomeIds'],
            properties: { achievementId: { type: 'string' }, observableEvidence: { type: 'string' }, outcomeIds: { type: 'array', items: { type: 'string' } } } },
        },
        days: {
          type: 'array', minItems: 1,
          items: { type: 'object', additionalProperties: false,
            required: ['day', 'stableActivityId', 'title', 'actionInstruction', 'userFacingWhy', 'estimatedMinutes', 'achievementIds', 'evidencePolicy'],
            properties: {
              day: { type: 'integer', minimum: 1 },
              stableActivityId: { type: 'string' },
              title: { type: 'string' },
              actionInstruction: { type: 'string' },
              userFacingWhy: { type: 'string' },
              estimatedMinutes: { type: 'number', minimum: 1 },
              achievementIds: { type: 'array', items: { type: 'string' } },
              evidencePolicy: { type: 'string', enum: ['attestation', 'note', 'photo', 'measurement'] },
              isRecovery: { type: 'boolean' },
              // ADR 0458 §2.2 (correction) — dossier claim ids the day relies on.
              claimRefs: { type: 'array', items: { type: 'string' } },
              // ADR 0429 P4 substitutions. Taken from the producer's schema rather
              // than restated: a copy here once lacked this field, so every plan
              // with alternatives failed typed persistence and was stored as an
              // untyped JSON blob titled `{` (P9, 2026-10-28). Only this field is
              // shared; the looser historical optionals above are kept as they were.
              alternatives: CHALLENGE_PLAN_JSON_SCHEMA.properties.days.items.properties.alternatives,
            } },
        },
      },
    },
    export: ['json'],
    registrationSource: 'host',
  });

  registerArtifactType({
    artifactTypeId: CHALLENGE_LESSON_BATCH_TYPE,
    title: 'KickTodo lesson checkpoint',
    schema: CHALLENGE_LESSON_BATCH_SCHEMA as unknown as Record<string, unknown>,
    export: ['json'],
    registrationSource: 'host',
  });
}
