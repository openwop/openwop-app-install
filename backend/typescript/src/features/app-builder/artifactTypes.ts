/**
 * App-builder canvas artifact type (ADR 0153 Phase 2). `canvas.app-builder` is a
 * structured app design — screens, a component tree per screen, and the connectors
 * between screens — emitted by the App Architect agent or a run, rendered inline in
 * the chat workbench and (Phase 2b) editable full-screen over `host.canvas`.
 *
 * The JSON Schema here enforces the STRUCTURE (screens/components/connectors,
 * `additionalProperties:false`); the closed-world COMPONENT validation (a `type` must
 * be in the catalog) is `host/canvasComponentCatalog.validateComponentTree`, applied
 * by the producer/editor — schema + catalog together. Structured JSON, never code.
 */
import { registerArtifactType } from '../../host/artifactTypes.js';

export function appBuilderSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['name', 'screens'],
    $defs: {
      component: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', minLength: 1 },
          props: { type: 'object' },
          children: { type: 'array', items: { $ref: '#/$defs/component' }, maxItems: 200 },
        },
        additionalProperties: false,
      },
    },
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 2000 },
      theme: { type: 'string', enum: ['default', 'light', 'dark'] },
      screens: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            route: { type: 'string', maxLength: 200 },
            isInitial: { type: 'boolean' },
            components: { type: 'array', items: { $ref: '#/$defs/component' }, maxItems: 200 },
          },
          additionalProperties: false,
        },
      },
      connectors: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', minLength: 1 },
            to: { type: 'string', minLength: 1 },
            trigger: { type: 'string', enum: ['click', 'submit', 'load'] },
            label: { type: 'string', maxLength: 120 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

let registered = false;

/** Register `canvas.app-builder`. Idempotent; called at boot from the feature. */
export function registerAppBuilderArtifactType(): void {
  if (registered) return;
  registerArtifactType({
    artifactTypeId: 'canvas.app-builder',
    title: 'App Builder',
    schema: appBuilderSchema(),
    export: ['json'],
    registrationSource: 'host',
  });
  registered = true;
}
