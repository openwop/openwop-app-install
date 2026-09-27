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
          // ADR 0344 2b (additive): authoring visibility/immutability traits.
          // `hidden` nodes are skipped by READ renderers + every export
          // generator; `locked` nodes refuse editor gestures. Neither is a
          // runtime-app concept — they never reach generated source semantics.
          hidden: { type: 'boolean' },
          locked: { type: 'boolean' },
          // ADR 0343 (additive): the closed action graph — registered kinds with
          // typed params, NEVER an expression language or code. validateAppDoc
          // enforces per-kind param requirements hard + reference targets soft.
          actions: { type: 'array', maxItems: 5, items: { $ref: '#/$defs/action' } },
          // ADR 0343 (additive): typed binding paths over state/model/operation/
          // sample-source outputs, keyed by the prop they feed. `list.bind`
          // (ADR 0305 C) stays valid; this is the general mechanism.
          bindings: {
            type: 'object',
            maxProperties: 10,
            propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
            additionalProperties: { $ref: '#/$defs/binding' },
          },
        },
        additionalProperties: false,
      },
      action: {
        type: 'object',
        required: ['on', 'kind'],
        properties: {
          on: { type: 'string', enum: ['click', 'submit', 'load', 'change'] },
          kind: { type: 'string', enum: ['navigate', 'set-state', 'submit-form', 'invoke-operation', 'open-modal', 'close-modal'] },
          to: { type: 'string', minLength: 1, maxLength: 80 },
          state: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
          value: {},
          operation: { type: 'string', minLength: 1, maxLength: 80 },
          onSuccess: { $ref: '#/$defs/actionFollowup' },
          onError: { $ref: '#/$defs/actionFollowup' },
          modal: { type: 'string', minLength: 1, maxLength: 80 },
        },
        additionalProperties: false,
      },
      actionFollowup: {
        type: 'object',
        properties: {
          navigate: { type: 'string', minLength: 1, maxLength: 80 },
          setState: {
            type: 'object',
            required: ['state'],
            properties: { state: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' }, value: {} },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      binding: {
        type: 'object',
        required: ['path'],
        properties: {
          // state.cart | model.task.title | op.listTasks.items | source.workouts.title
          path: { type: 'string', maxLength: 200, pattern: '^(state|model|op|source)\\.[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*){0,4}$' },
          fallback: { type: 'string', maxLength: 200 },
          format: { type: 'string', enum: ['text', 'number', 'currency', 'date'] },
          mode: { type: 'string', enum: ['one-way', 'two-way'] },
        },
        additionalProperties: false,
      },
      modelField: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
          type: { type: 'string', enum: ['string', 'number', 'boolean', 'date', 'reference'] },
          required: { type: 'boolean' },
          default: {},
          referenceTo: { type: 'string', minLength: 1, maxLength: 80 },
          validation: {
            type: 'object',
            properties: {
              pattern: { type: 'string', maxLength: 200 },
              min: { type: 'number' },
              max: { type: 'number' },
              maxLength: { type: 'integer', minimum: 0, maximum: 100000 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      opField: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
          type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'list'] },
          required: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      resourceRef: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 120 },
          mode: { type: 'string', enum: ['linked', 'detached'] },
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
            // ADR 0323 (additive): the screen's position as a node on the
            // screen-flow graph. Optional — absent screens auto-layout in the
            // editor. Bounded so an AI-emitted position that passes THIS schema
            // (the producer/emit path) also passes validateAppDoc's ±100000 bound
            // (the editor PATCH path) — the two gates agree (ADR 0323 Phase 4).
            x: { type: 'number', minimum: -100000, maximum: 100000 },
            y: { type: 'number', minimum: -100000, maximum: 100000 },
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
            // ADR 0323 (additive): screen-flow edge presentation. All optional;
            // validateAppDoc enforces enum membership hard on the editor path.
            sourceEdge: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] },
            targetEdge: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] },
            transition: { type: 'string', enum: ['push', 'replace', 'modal', 'fade', 'slide', 'none'] },
            routingStyle: { type: 'string', enum: ['bezier', 'orthogonal', 'straight', 'step'] },
            animated: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      // ADR 0305 Phase C (additive): design-time sample data for `list.bind` +
      // `{{field}}` interpolation. Sample rows only — never live data.
      dataSources: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          required: ['id', 'name', 'fields'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            fields: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 60 } },
            rows: { type: 'array', maxItems: 10, items: { type: 'object' } },
          },
          additionalProperties: false,
        },
      },
      // ADR 0305 Phase C (additive): app-level theme tokens. The renderer
      // re-validates the hex pattern before injecting a CSS variable.
      themeColors: {
        type: 'object',
        properties: {
          primary: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          secondary: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        },
        additionalProperties: false,
      },
      // ── ADR 0343 (all additive, all optional): the comprehensive application
      // document. Symbolic references only — NEVER a credential, URL secret, or
      // executable content; the validator + export scrub are the backstops. ──
      // Documents without schemaVersion are v1 by definition (every pre-0343
      // document validates unchanged); migrateAppDoc owns forward migration.
      schemaVersion: { type: 'integer', minimum: 1, maximum: 100 },
      // DS-02/04: resolved server-side by the design-system/Brand owners.
      designSystemRef: { $ref: '#/$defs/resourceRef' },
      brandRef: { $ref: '#/$defs/resourceRef' },
      // PR-02: ephemeral preview/runtime state. Names are `\w`-safe — they become
      // binding-path segments and generated identifiers (the RFC 0124 lesson).
      stateVariables: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['id', 'type'],
          properties: {
            id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
            label: { type: 'string', maxLength: 120 },
            type: { type: 'string', enum: ['string', 'number', 'boolean', 'list'] },
            initial: {},
          },
          additionalProperties: false,
        },
      },
      // DA-02: the governed domain model (design-time contract, not live data).
      models: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          required: ['id', 'name', 'fields'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            fields: { type: 'array', minItems: 1, maxItems: 40, items: { $ref: '#/$defs/modelField' } },
            relationships: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['to', 'kind'],
                properties: {
                  to: { type: 'string', minLength: 1, maxLength: 80 },
                  kind: { type: 'string', enum: ['hasOne', 'hasMany', 'belongsTo'] },
                  name: { type: 'string', maxLength: 60 },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      // DA-04: the operation/API contract. Input/output are CLOSED typed field
      // lists (an as-built correction to the ADR 0343 sketch's `inputSchema` —
      // raw JSON Schema objects inside an additionalProperties:false document
      // would reopen the closed world). `adapterRef` names an installed adapter
      // id; raw URLs/credentials are rejected by the validator.
      operations: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['id', 'name', 'kind'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            purpose: { type: 'string', maxLength: 400 },
            kind: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'action'] },
            modelId: { type: 'string', minLength: 1, maxLength: 80 },
            input: { type: 'array', maxItems: 20, items: { $ref: '#/$defs/opField' } },
            output: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: ['model', 'modelList', 'object', 'none'] },
                fields: { type: 'array', maxItems: 20, items: { $ref: '#/$defs/opField' } },
              },
              additionalProperties: false,
            },
            auth: { type: 'string', enum: ['none', 'user', 'role'] },
            role: { type: 'string', maxLength: 60 },
            adapterRef: { type: 'string', minLength: 1, maxLength: 120 },
            mock: {
              type: 'object',
              required: ['status'],
              properties: {
                status: { type: 'string', enum: ['ok', 'error'] },
                rows: { type: 'array', maxItems: 10, items: { type: 'object' } },
                message: { type: 'string', maxLength: 200 },
              },
              additionalProperties: false,
            },
            errors: {
              type: 'array',
              maxItems: 10,
              items: {
                type: 'object',
                required: ['code'],
                properties: {
                  code: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
                  message: { type: 'string', maxLength: 200 },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      // DA-09: describes the GENERATED app's auth design — never host RBAC.
      authProfile: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['none', 'email-password', 'oauth', 'sso'] },
          roles: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' } },
          guards: {
            type: 'array',
            maxItems: 60,
            items: {
              type: 'object',
              required: ['screenId'],
              properties: {
                screenId: { type: 'string', minLength: 1, maxLength: 80 },
                requiresRole: { type: 'string', maxLength: 40 },
                redirectTo: { type: 'string', minLength: 1, maxLength: 80 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      // DA-13: SYMBOLIC environment requirements — values live in host
      // Connections/secret management, never in this document.
      envRequirements: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          required: ['key', 'purpose'],
          properties: {
            key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
            purpose: { type: 'string', minLength: 1, maxLength: 200 },
            requiredFor: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['runtime', 'build', 'deploy'] } },
          },
          additionalProperties: false,
        },
      },
      // CV-07: reusable closed component subtrees, referenced by id. The
      // referencing component type + scoped-frame editing land with the Phase-2
      // chassis work; storage/validation are established here so AI + templates
      // can emit definitions additively.
      componentDefinitions: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          required: ['id', 'name', 'root'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            root: { $ref: '#/$defs/component' },
          },
          additionalProperties: false,
        },
      },
      // ADR 0345 3a (DS-08): share redaction policy — enforced server-side by
      // `projectAppForShare` in the sharing resolver (landed together, per the
      // ADR 0343 no-schema-without-enforcement rule). Default (absent) REDACTS
      // sample rows on public shares.
      sharePolicy: {
        type: 'object',
        properties: {
          sampleData: { type: 'string', enum: ['redact', 'include'] },
          perSource: {
            type: 'object',
            maxProperties: 20,
            propertyNames: { pattern: '^[A-Za-z0-9._-]{1,80}$' },
            additionalProperties: { type: 'boolean' },
          },
        },
        additionalProperties: false,
      },
      // Deliberately NOT here yet (ADR 0343 as-built): `outputLineage` lands
      // with its Phase-6 writer.
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
