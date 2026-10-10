/**
 * ADR 0763 — the ONE owner of the legacy → canonical agent-id mapping.
 *
 * The v1 AgentManifest grammar (`schemas/agent-manifest.schema.json`) only
 * admits `core|vendor|community|private|local` namespaces. This host's feature
 * agent packs were named `feature.<feature>.agents` (ADR 0001), so their agent
 * ids (`feature.crm.agents.sales-ops`) are renamed into `vendor.openwop-app.*`.
 *
 * A RULE, not a hand-maintained table: every agent id under a `feature.*.agents`
 * pack maps by replacing the `feature.` scope with `vendor.openwop-app.`. The one
 * exception is `career-agent`, which never matched its own pack's prefix (so the
 * loader refused it — the latent bug ADR 0763 records) and is mapped explicitly.
 *
 * PERMANENT. A run recorded under a legacy id must still fork years later: the
 * agent-runner node re-resolves `inputs.agentId` on `:fork`, and recorded run
 * events keep the id they were written with. Never delete a mapping.
 *
 * ONE-WAY and CANONICAL-IF-REGISTERED. Callers resolve through
 * `resolveAgentIdSpelling`, which prefers the canonical id only when an agent is
 * actually registered under it. Before the rename lands nothing is registered
 * under a canonical id, so this module changes nothing — that is what lets it
 * ship ahead of the rename (ADR 0763 review #1).
 */

/** The vendor scope the renamed agent packs live under (ADR 0763 D1). */
export const CANONICAL_AGENT_SCOPE = 'vendor.openwop-app.';
const LEGACY_AGENT_SCOPE = 'feature.';

/** Explicit exceptions the rule cannot express (legacy → canonical). */
const EXPLICIT: ReadonlyMap<string, string> = new Map([
  ['career-agent', 'vendor.openwop-app.career-agent.agents.default'],
]);
const EXPLICIT_INVERSE: ReadonlyMap<string, string> = new Map([...EXPLICIT].map(([l, c]) => [c, l]));

/** True for an id under a legacy `feature.<feature…>.agents` pack. The feature
 *  part may have MORE than one segment (`feature.commerce.buyer.agents.*`), so
 *  the test is "an exact `agents` segment after at least one feature segment,
 *  followed by the agent's own name" — never a fixed position. A feature NODE
 *  typeId (`feature.crm.nodes.x`) has no `agents` segment and is not an agent. */
function isLegacyFeatureAgentId(id: string): boolean {
  if (!id.startsWith(LEGACY_AGENT_SCOPE)) return false;
  const parts = id.split('.');
  const at = parts.indexOf('agents', 2);
  return at >= 2 && at < parts.length - 1;
}

/**
 * The canonical spelling of an agent id. Returns the input unchanged for an id
 * that has no legacy form (every `core.*`, `vendor.*`, `user.*`, `host:*` id).
 */
export function canonicalAgentId(id: string): string {
  const explicit = EXPLICIT.get(id);
  if (explicit !== undefined) return explicit;
  if (isLegacyFeatureAgentId(id)) return CANONICAL_AGENT_SCOPE + id.slice(LEGACY_AGENT_SCOPE.length);
  return id;
}

/** The legacy spelling of a canonical id, or undefined when it has none. */
export function legacyAgentId(canonical: string): string | undefined {
  const explicit = EXPLICIT_INVERSE.get(canonical);
  if (explicit !== undefined) return explicit;
  if (!canonical.startsWith(CANONICAL_AGENT_SCOPE)) return undefined;
  const legacy = LEGACY_AGENT_SCOPE + canonical.slice(CANONICAL_AGENT_SCOPE.length);
  return isLegacyFeatureAgentId(legacy) ? legacy : undefined;
}

/**
 * Every spelling of ONE agent — canonical first, then the legacy form when it
 * has one. For read-through lookups and for erasure (a subject eraser must hit
 * the legacy copy too; ADR 0763 review #5). Order matters: canonical wins.
 */
export function agentIdForms(id: string): readonly string[] {
  const canonical = canonicalAgentId(id);
  const legacy = legacyAgentId(canonical);
  return legacy !== undefined && legacy !== canonical ? [canonical, legacy] : [canonical];
}

/**
 * The ONE spelling an agent-id-KEYED store uses for its key (profiles, tool
 * allowlist overrides, memory scopes, DM keys). It is the pre-rename spelling
 * whenever the agent has one, so a legacy and a canonical id address the SAME
 * row — no split, no backfill, no second copy for erasure to miss (ADR 0763 D3
 * correction). Storage keys are not wire; the wire only ever shows canonical ids.
 */
export function agentStorageId(id: string): string {
  return legacyAgentId(canonicalAgentId(id)) ?? id;
}

/**
 * The spelling to USE for `id`: the canonical one when `isRegistered` says an
 * agent exists under it, otherwise the literal input. Inert until the rename.
 */
export function resolveAgentIdSpelling(id: string, isRegistered: (candidate: string) => boolean): string {
  const canonical = canonicalAgentId(id);
  if (canonical !== id && isRegistered(canonical)) return canonical;
  return id;
}

/**
 * ADR 0763 — the same rename, for AGENT PACK NAMES (`feature.<f…>.agents` ⇄
 * `vendor.openwop-app.<f…>.agents`). Pack-name-KEYED stores (per-tenant pack
 * disables, marketplace tombstones) key on `packStorageName` and answer
 * membership for BOTH spellings, so a tenant that disabled the old name keeps it
 * disabled under the new one. Non-agent `feature.*` packs are unchanged (D6).
 */
function isLegacyAgentPackName(name: string): boolean {
  if (!name.startsWith(LEGACY_AGENT_SCOPE)) return false;
  const parts = name.split('.');
  return parts.length >= 3 && parts[parts.length - 1] === 'agents';
}
export function canonicalPackName(name: string): string {
  return isLegacyAgentPackName(name) ? CANONICAL_AGENT_SCOPE + name.slice(LEGACY_AGENT_SCOPE.length) : name;
}
export function packStorageName(name: string): string {
  if (!name.startsWith(CANONICAL_AGENT_SCOPE)) return name;
  const legacy = LEGACY_AGENT_SCOPE + name.slice(CANONICAL_AGENT_SCOPE.length);
  return isLegacyAgentPackName(legacy) ? legacy : name;
}
/** Every spelling of one pack name (canonical first). */
export function packNameForms(name: string): readonly string[] {
  const canonical = canonicalPackName(name);
  const stored = packStorageName(canonical);
  return stored !== canonical ? [canonical, stored] : [canonical];
}
