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

/**
 * READ-SIDE artifact-type id aliases (PMC-4, host-internal).
 *
 * This host's native ids predate the canonical namespace pattern
 * `^(core|vendor|community|private)\.` that
 * `artifact-type-pack-manifest.schema.json` requires, so `canvas.checklist`,
 * `doc.one-pager` and `brand.kit` are not wire-conformant names.
 *
 * They CANNOT simply be renamed. `detectTypedArtifact`
 * (`runArtifactStore.ts:141`) reads `artifactTypeId` out of a NODE OUTPUT
 * ENVELOPE, so these ids live in the run-event log — immutable, and replayed.
 * Rewriting them would either break `:fork` determinism or leave a replayed run
 * emitting an id the registry no longer knows, whereupon
 * `isRegisteredArtifactType` returns false and the artifact SILENTLY stops being
 * typed. That is a worse outcome than the non-conformant name.
 *
 * So resolution is READ-ONLY and PERMANENT, not transitional: an alias is
 * consulted when looking a type UP, and no stored or emitted id is ever
 * rewritten. Because historical events are immutable, the reader must accept the
 * legacy spelling forever.
 *
 * Direction: canonical → native. A caller using the conformant name resolves to
 * the registration that already exists, so a spec-conformant consumer works today
 * without touching the 19 files that reference the native ids as literals. If the
 * packs are ever re-minted under canonical ids, this map inverts rather than
 * disappears — the legacy arm is what old events need.
 *
 * NOT a conformance claim. Until the corpus states plainly that these ids were
 * never wire-conformant (logged upstream as G5), this is a host compatibility
 * shim and must not be advertised as anything else.
 */
const ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ['community.openwop.canvas.checklist', 'canvas.checklist'],
  ['core.openwop.doc.one-pager', 'doc.one-pager'],
  ['core.openwop.brand.kit', 'brand.kit'],
]);

/** Resolve an id through the alias table. Returns the input when unaliased. */
export function resolveArtifactTypeId(id: string): string {
  const target = ID_ALIASES.get(id);
  // An alias only resolves when its TARGET is actually registered. A dangling
  // alias must not shadow a real miss, or a typo'd canonical id would look
  // "registered" while resolving to nothing.
  return target !== undefined && registry.has(target) ? target : id;
}

export function getArtifactType(id: string): ArtifactType | undefined {
  return registry.get(resolveArtifactTypeId(id));
}

export function listArtifactTypes(): ArtifactType[] {
  return [...registry.values()].sort((a, b) => a.artifactTypeId.localeCompare(b.artifactTypeId));
}

export function isRegisteredArtifactType(id: string): boolean {
  return registry.has(resolveArtifactTypeId(id));
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
  // Alias-resolve here too. `validateArtifact` is the path a RUN takes
  // (`detectTypedArtifact` -> validate -> persist), so a canonical id that
  // resolved for `isRegisteredArtifactType` but not here would pass the gate and
  // then validate against nothing — registered:false, valid:true, silently
  // untyped. Resolve once and key the validator cache off the resolved id so the
  // two spellings share one compiled schema.
  const resolvedId = resolveArtifactTypeId(artifactTypeId);
  const t = registry.get(resolvedId);
  if (!t) return { registered: false, valid: true };
  let v = validators.get(resolvedId);
  if (!v) { v = ajv.compile(t.schema); validators.set(resolvedId, v); }
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
