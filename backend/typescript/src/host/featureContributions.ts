/**
 * ADR 1031 P2 — small host tables a FEATURE contributes to by declaration
 * (`BackendFeature.hostContributions`) instead of a row in a host file.
 *
 * A LEAF (type-only imports), recorded once at composition (`features/index.ts`,
 * right after the security seal), so whatever the module load order a consumer
 * reads the composed union — the same timing a static host row had wherever the
 * registry is loaded. A value claimed by two features is a boot error.
 *
 *  - participant-facing run purposes (ADR 0710 §C, `notifications/runNoticeAudience.ts`)
 *  - plan-limit keys with an enforcement site (ADR 0821, `host/planLimitsSeam.ts`)
 *  - expected subject erasers (`host/subjectEraserManifest.ts`)
 *
 * Round 3 (ADR 1031 addendum "round 3") adds three tables that WIDEN a security
 * surface, so they are census-tracked like `BackendFeature.security`
 * (`featureHostTableSurface()` → `test/feature-security-census.test.ts`):
 *  - tenant-level KB namespaces (ADR 0830 D1, `features/kb/kbService.ts`)
 *  - managed KB sources and the toggle their content is sold under (ADR 0820 G8)
 *  - pure compute nodes projected as live agent tools (ADR 0081 P3,
 *    `host/agentToolProvider.ts`)
 * All three are ADD-ONLY. A host module hands over its own values
 * (`reserveHostValues`), and a feature that redeclares one is a boot error,
 * whichever of the two loads first. No feature can override or remove a host
 * entry.
 */
import type { BackendFeature } from '../features/types.js';

export interface FeatureHostContributions {
  /** `metadata.purpose` values of runs that execute headlessly on behalf of a
   *  participant: their failures are an operator's problem (ADR 0710 §C). */
  participantFacingRunPurposes?: readonly string[];
  /** Plan-limit keys this feature ENFORCES (ADR 0821: only enforced keys display). */
  enforcedPlanLimitKeys?: readonly string[];
  /** Names of the subject erasers this feature registers, for the DSAR manifest. */
  subjectErasers?: readonly string[];
  /** Exact node typeIds that are SIDE-EFFECTING although their pack `.mjs` cannot
   *  say so (they reach an effect through this feature's host surface), so replay
   *  serves the recorded outcome instead of re-executing them (ADR 0341/0572). */
  sideEffectingNodeTypes?: readonly string[];
  /** Round 3 — synthetic KB "org" ids (`_<name>`) this feature's managed indexer
   *  files a TENANT-level collection under. Anyone in the tenant can recall it
   *  (ADR 0830 D1), so it is a reviewed, census-tracked declaration. */
  kbTenantNamespaces?: readonly string[];
  /** Round 3 — managed KB sources (`KnowledgeCollection.managed`) this feature
   *  owns, each mapped to the toggle id its CONTENT is sold under, or `null` when
   *  it is not plan-gated (say why beside the declaration). ADR 0820 §8.1 G8. The
   *  TYPE comes from augmenting `FeatureManagedSources` in `kbService.ts`. */
  kbManagedSources?: Readonly<Record<string, string | null>>;
  /** Round 3 — node typeIds projected as live agent tools (`openwop:<typeId>`,
   *  ADR 0081 P3). Each must be a PURE compute node: its pack manifest says
   *  `role:"pure"`, and it reads only `ctx.config`/`ctx.inputs`. The tool is gated
   *  on THIS feature's toggle and plan, and it refuses at call time unless the
   *  manifest says `pure`. */
  projectableComputeNodes?: ReadonlyArray<{ typeId: string; schemaCarrying?: true }>;
}

const purposes = new Map<string, string>();
const planLimitKeys = new Map<string, string>();
const erasers = new Map<string, string>();
const sideEffectingTypes = new Map<string, string>();
const kbNamespaces = new Map<string, string>();
const kbManaged = new Map<string, string>();
const kbManagedOwner = new Map<string, string | null>();
const projected = new Map<string, string>();
const projectedSchemaCarrying = new Set<string>();
let recorded = false;

/** Round 3 — the shapes a declaration must have. Checked at record time. */
const KB_NAMESPACE = /^_[a-z][a-z0-9-]{1,62}$/;
const KB_MANAGED_SOURCE = /^[a-z][a-z0-9-]{1,62}$/;
const TOGGLE_ID = /^[a-z][a-z0-9-]{1,62}$/;
const NODE_TYPE_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** what → the host's own values, handed over by the host module at load. */
const reserved = new Map<string, Set<string>>();

function add(store: Map<string, string>, what: string, featureId: string, values: readonly string[] | undefined, shape?: RegExp): void {
  for (const v of values ?? []) {
    if (shape && !shape.test(v)) throw new Error(`${what} '${v}' declared by '${featureId}' does not match ${shape} (ADR 1031 round 3)`);
    if (reserved.get(what)?.has(v)) throw new Error(`${what} '${v}' is a host value; '${featureId}' may add to the table, never redeclare a host entry (ADR 1031 round 3)`);
    const owner = store.get(v);
    if (owner !== undefined && owner !== featureId) throw new Error(`${what} '${v}' is declared by both '${owner}' and '${featureId}' (ADR 1031 P2)`);
    store.set(v, featureId);
  }
}

const STORES: Readonly<Record<string, Map<string, string>>> = {
  'kb tenant namespace': kbNamespaces,
  'kb managed source': kbManaged,
  'projected compute node': projected,
};

/**
 * Round 3 — a HOST module hands over its own entries for a feature-extensible
 * table, so a feature cannot redeclare one. Idempotent per value. Callable before or
 * after the registry records, so module evaluation order does not matter.
 */
export function reserveHostValues(what: 'kb tenant namespace' | 'kb managed source' | 'projected compute node', values: readonly string[]): void {
  const set = reserved.get(what) ?? new Set<string>();
  for (const v of values) {
    const owner = STORES[what]!.get(v);
    if (owner !== undefined) throw new Error(`${what} '${v}' is a host value; '${owner}' may add to the table, never redeclare a host entry (ADR 1031 round 3)`);
    set.add(v);
  }
  reserved.set(what, set);
}

/** Called once, by the registry, with the composed list. Undefined entries are
 *  import-cycle holes (composeFeatures.ts) and contribute nothing. */
export function recordFeatureHostContributions(features: ReadonlyArray<Pick<BackendFeature, 'id' | 'hostContributions'> | undefined>): void {
  if (recorded) throw new Error('feature host contributions were recorded twice (ADR 1031 P2)');
  recorded = true;
  for (const f of features) {
    if (!f?.hostContributions) continue;
    add(purposes, 'participant-facing purpose', f.id, f.hostContributions.participantFacingRunPurposes);
    add(planLimitKeys, 'plan-limit key', f.id, f.hostContributions.enforcedPlanLimitKeys);
    add(erasers, 'subject eraser', f.id, f.hostContributions.subjectErasers);
    add(sideEffectingTypes, 'side-effecting node type', f.id, f.hostContributions.sideEffectingNodeTypes);
    add(kbNamespaces, 'kb tenant namespace', f.id, f.hostContributions.kbTenantNamespaces, KB_NAMESPACE);
    const managed = f.hostContributions.kbManagedSources ?? {};
    add(kbManaged, 'kb managed source', f.id, Object.keys(managed), KB_MANAGED_SOURCE);
    for (const [source, owner] of Object.entries(managed)) {
      if (owner !== null && !TOGGLE_ID.test(owner)) throw new Error(`kb managed source '${source}' declared by '${f.id}' names owner '${String(owner)}', which is neither a toggle id nor null (ADR 1031 round 3)`);
      kbManagedOwner.set(source, owner);
    }
    const nodes = f.hostContributions.projectableComputeNodes ?? [];
    add(projected, 'projected compute node', f.id, nodes.map((n) => n.typeId), NODE_TYPE_ID);
    for (const n of nodes) if (n.schemaCarrying) projectedSchemaCarrying.add(n.typeId);
  }
}

/** Has the registry recorded the composed declarations yet? */
export const featureHostContributionsRecorded = (): boolean => recorded;

export const featureParticipantFacingPurposes = (): string[] => [...purposes.keys()];
/** purpose → declaring feature (the ADR 0710 leg-5 ratchet checks the declarer writes it). */
export const featureParticipantFacingPurposeOwners = (): Array<{ featureId: string; purpose: string }> => [...purposes].map(([purpose, featureId]) => ({ featureId, purpose }));
export const featureEnforcedPlanLimitKeys = (): string[] => [...planLimitKeys.keys()];
export const featureSubjectErasers = (): string[] => [...erasers.keys()];
export const featureSideEffectingNodeTypes = (): string[] => [...sideEffectingTypes.keys()];

/** Round 3 — feature-declared tenant-level KB namespaces (the host's are in kbService). */
export const featureKbTenantNamespaces = (): string[] => [...kbNamespaces.keys()];
/** Round 3 — a feature-declared managed KB source's owner toggle: `undefined` when
 *  no feature declared `source`, `null` when it is declared and not plan-gated. */
export const featureKbManagedSourceOwner = (source: string): string | null | undefined =>
  kbManaged.has(source) ? (kbManagedOwner.get(source) ?? null) : undefined;
/** Round 3 — feature-declared projected compute nodes, with the declaring feature. */
export const featureProjectedComputeNodes = (): Array<{ typeId: string; featureId: string; schemaCarrying: boolean }> =>
  [...projected].map(([typeId, featureId]) => ({ typeId, featureId, schemaCarrying: projectedSchemaCarrying.has(typeId) }));

/**
 * Round 3 — the census lines for the three security-widening tables. One line per
 * entry, the same `{ featureId, entry }` shape as `featureSecuritySurface()`.
 * `test/feature-security-census.test.ts` compares them with the owning package's
 * `security.census.json`, so the baseline diff is the review surface.
 */
export function featureHostTableSurface(): Array<{ featureId: string; entry: string }> {
  return [
    ...[...kbNamespaces].map(([ns, featureId]) => ({ featureId, entry: `kb-tenant-namespace ${ns}` })),
    ...[...kbManaged].map(([src, featureId]) => ({ featureId, entry: `kb-managed-source ${src} -> ${kbManagedOwner.get(src) ?? '(not plan-gated)'}` })),
    ...featureProjectedComputeNodes().map((n) => ({ featureId: n.featureId, entry: `projected-compute-node ${n.typeId}${n.schemaCarrying ? ' (schema-carrying)' : ''}` })),
  ];
}
