/**
 * Host artifact-type registry (ADR 0055 — implements RFC 0071/0075). The single
 * owner of "what artifact types this host knows": a stable `artifactTypeId` → JSON
 * Schema + export facets + registration source. Used to (a) advertise
 * `host.artifactTypes` at `/.well-known/openwop`, (b) serve schemas at
 * `/schemas/artifacts/{id}.schema.json`, and (c) validate an emitted artifact before
 * an `artifact.created` run event. Unregistered types stay valid (the RFC 0071
 * escape hatch) — only a REGISTERED type's payload MUST validate.
 *
 * v1 ships host-native types only (`registrationSource:'host'`); the
 * `kind:'artifact-type'` pack tier (RFC 0075) is a deferred follow-on (ADR 0055
 * §Phase 3) — no parallel registry, packs will register through this same seam.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import { type ValidateFunction } from 'ajv';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.artifactTypes');
// 2020-12 dialect — the artifact schemas declare `$schema: …/2020-12/schema`.
const ajv = new Ajv2020({ allErrors: true, strict: false });

export interface ArtifactType {
  /** Stable id, e.g. `doc.sow`. */
  artifactTypeId: string;
  title: string;
  /** JSON Schema the artifact payload validates against. */
  schema: Record<string, unknown>;
  /** Export/render facets this type supports (ADR 0054 formats). */
  export: string[];
  registrationSource: 'host' | 'pack';
}

const registry = new Map<string, ArtifactType>();
const validators = new Map<string, ValidateFunction>();

export function registerArtifactType(t: ArtifactType): void {
  registry.set(t.artifactTypeId, t);
  validators.delete(t.artifactTypeId);
  log.debug('artifact_type_registered', { artifactTypeId: t.artifactTypeId, source: t.registrationSource });
}

export function getArtifactType(id: string): ArtifactType | undefined {
  return registry.get(id);
}

export function listArtifactTypes(): ArtifactType[] {
  return [...registry.values()].sort((a, b) => a.artifactTypeId.localeCompare(b.artifactTypeId));
}

export function isRegisteredArtifactType(id: string): boolean {
  return registry.has(id);
}

export interface ArtifactValidation {
  registered: boolean;
  registrationSource?: 'host' | 'pack';
  valid: boolean;
  errors?: string[];
}

/** Validate `payload` against a registered type's schema. An unregistered type is
 *  `{registered:false, valid:true}` (RFC 0071 escape hatch). */
export function validateArtifact(artifactTypeId: string, payload: unknown): ArtifactValidation {
  const t = registry.get(artifactTypeId);
  if (!t) return { registered: false, valid: true };
  let v = validators.get(artifactTypeId);
  if (!v) { v = ajv.compile(t.schema); validators.set(artifactTypeId, v); }
  const valid = v(payload) === true;
  return {
    registered: true,
    registrationSource: t.registrationSource,
    valid,
    ...(valid ? {} : { errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).slice(0, 10) }),
  };
}

/** The document-content artifact envelope: durable markdown `content` + light meta. */
function docSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['content'],
    properties: {
      content: { type: 'string', minLength: 1 },
      title: { type: 'string' },
      kind: { type: 'string' },
      documentId: { type: 'string' },
    },
    additionalProperties: true,
  };
}

/** Host-native artifact types — one per seeded business-document kind + a generic.
 *  Called once at boot. Idempotent. */
export function seedHostArtifactTypes(): void {
  const docKinds: Array<[string, string]> = [
    ['doc.sow', 'Statement of Work'],
    ['doc.prd', 'Product Requirements Document'],
    ['doc.rfp', 'Request for Proposal'],
    ['doc.epic-brief', 'Epic Brief'],
    ['doc.board-agenda', 'Board Meeting Agenda'],
    ['doc.markdown', 'Markdown Document'],
  ];
  for (const [artifactTypeId, title] of docKinds) {
    if (!registry.has(artifactTypeId)) {
      registerArtifactType({ artifactTypeId, title, schema: docSchema(), export: ['pdf', 'slides', 'sheet'], registrationSource: 'host' });
    }
  }
  log.info('host_artifact_types_seeded', { count: registry.size });
}

/** Test-only: drop all registered types. */
export function __resetArtifactTypes(): void {
  registry.clear();
  validators.clear();
}
