/**
 * kicktodo.* artifact types (ADR 0414 P4; PRD §8.6) — registered with the ONE
 * host artifact registry. Host-native (`registrationSource:'host'`); a
 * portable artifact-type pack is added only when another host needs the types
 * (PRD rule). Only types the shipped loop actually PRODUCES are registered —
 * the factory types (`kicktodo.challenge-plan`, `kicktodo.challenge-release-
 * bundle`, …) arrive with their producers in ADR 0415.
 *
 * SSoT rule (CLAUDE.md AI-exchange): the `kicktodo.progress-evidence` schema
 * is TEST-PINNED to its producer — `kicktodoArtifactParity.test.ts` freezes a
 * real snapshot and validates it against this schema, so drift between the
 * producer and the schema text is a red test, not a lie to a model.
 */

import { registerArtifactType } from '../../host/artifactTypes.js';

export const PROGRESS_EVIDENCE_TYPE = 'kicktodo.progress-evidence';
export const COMPLETION_CERTIFICATE_TYPE = 'kicktodo.completion-certificate';
/** ADR 0459 P1 — the participant-replan approval card's artifact type. Its shape
 *  mirrors the agents-pack `plan-revision.schema.json` (the composer's SSoT return
 *  contract); the authoritative closed-world validation lives in the composer
 *  return schema + `replanService.applyRevisionCommands`, so this schema is the
 *  card's render contract, not a second validator. */
export const PLAN_REVISION_TYPE = 'kicktodo.plan-revision';

export function registerKicktodoArtifactTypes(): void {
  registerArtifactType({
    artifactTypeId: PROGRESS_EVIDENCE_TYPE,
    title: 'KickTodo progress evidence',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'tenantId', 'enrollmentId', 'challengeId', 'challengeVersion', 'challengeContentHash',
        'planRevision', 'asOf', 'totalRequiredActivities', 'completedActivities', 'checkInCount',
        'occurrences', 'snapshotHash',
      ],
      properties: {
        id: { type: 'string' },
        tenantId: { type: 'string' },
        enrollmentId: { type: 'string' },
        challengeId: { type: 'string' },
        challengeVersion: { type: 'integer', minimum: 1 },
        challengeContentHash: { type: 'string', pattern: '^sha256:' },
        planRevision: { type: 'integer', minimum: 1 },
        asOf: { type: 'string' },
        totalRequiredActivities: { type: 'integer', minimum: 0 },
        completedActivities: { type: 'integer', minimum: 0 },
        checkInCount: { type: 'integer', minimum: 0 },
        occurrences: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['cardId', 'stableActivityId', 'completed'],
            properties: {
              cardId: { type: 'string' },
              stableActivityId: { type: 'string' },
              completed: { type: 'boolean' },
              checkedInAt: { type: 'string' },
            },
          },
        },
        snapshotHash: { type: 'string', pattern: '^sha256:' },
      },
    },
    export: ['json'],
    registrationSource: 'host',
  });

  registerArtifactType({
    artifactTypeId: COMPLETION_CERTIFICATE_TYPE,
    title: 'KickTodo completion certificate',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['enrollmentId', 'challengeId', 'challengeVersion', 'challengeTitle', 'completedAt'],
      properties: {
        enrollmentId: { type: 'string' },
        challengeId: { type: 'string' },
        challengeVersion: { type: 'integer', minimum: 1 },
        challengeTitle: { type: 'string' },
        completedAt: { type: 'string' },
      },
    },
    export: ['json'],
    registrationSource: 'host',
  });

  registerArtifactType({
    artifactTypeId: PLAN_REVISION_TYPE,
    title: 'KickTodo plan revision',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['commands', 'rationale'],
      properties: {
        commands: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            required: ['lane'],
            properties: {
              lane: { type: 'string', enum: ['schedule', 'substitute', 'recovery'] },
              daypart: { enum: ['morning', 'afternoon', 'evening', null] },
              cardId: { type: 'string' },
              alternativeId: { type: 'string' },
            },
          },
        },
        rationale: { type: 'string' },
        // ADR 0459 grade-fix — the server-composed HUMANIZED render (titles resolved,
        // no opaque ids). Additive + optional: the closed-world command list stays the
        // apply contract; `display` is the card's render aid, so a payload with it still
        // validates as a typed artifact (`detectTypedArtifact` gates on this schema).
        display: {
          type: 'object',
          additionalProperties: false,
          required: ['summary', 'lines'],
          properties: {
            summary: { type: 'string' },
            lines: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    export: ['json'],
    registrationSource: 'host',
  });
}
