/**
 * The v2 discovery document, re-expressed in the shape this SPA's consumers
 * were written against.
 *
 * WHY AN ADAPTER, NOT 14 CONSUMER REWRITES. ADR 0730 C.3 moved the discovery
 * read to v2 and left the consumers reading v1 paths. Each consumer's failure
 * mode is a `catch`, or an `undefined` that renders nothing, so it shipped five
 * silent UI regressions that no unit test, conformance lane or backend test
 * saw. One mapping in one place is reviewable; fourteen partial edits were not.
 * And one mapping can be tested against the real served documents, which is
 * what `backend/typescript/test/discovery-v2-adapter-parity.test.ts` does: it
 * serves both majors from the same host and asserts that every field a
 * consumer reads comes out of this function with the value v1 gave it.
 *
 * THE THREE DIFFERENCES THIS BRIDGES (measured against the served documents):
 *   1. Presence is the claim at major 2. v2 families carry no `supported`
 *      flag, so a present family maps back to `supported: true` and an absent
 *      one stays absent (never `supported: false`: v1 consumers read the two
 *      the same way, and inventing a `false` would be a claim the host did
 *      not make).
 *   2. Host-owned facts moved to `extensions`: `demoMode` to
 *      `openwop-app.host`, `hostSurfaces` to `openwop-app.host-surfaces`.
 *   3. `auth.profiles[]` became `auth.lanes[]`; a profile is re-derived from
 *      the lane that honours it.
 * Everything else the v2 root carries passes through unchanged, so a consumer
 * that already reads the v2 shape (`subscriptionProviders`, `InMemoryHostBanner`)
 * keeps working.
 *
 * KNOWN, DELIBERATE GAPS. v2 does not advertise `envelopes.reliability` (an
 * optional family this host does not claim at major 2), and has no
 * `capabilities.profiles[]` interrupt-profile list. Both are read only by the
 * wire-diagnostics `CapabilitiesPanel`, which then shows the v2 truth: a dash.
 */

/** v2 family metadata that has no v1 counterpart (`declaration.json` stamps). */
const FAMILY_META = new Set(['status', 'since', 'until', 'witness']);

/** A v2 lane, and the v1 profile it honours. A lane with no entry here maps to no profile. */
const LANE_PROFILES: Readonly<Record<string, string>> = {
  saml: 'openwop-auth-saml',
  scim: 'openwop-auth-scim',
  oidc: 'openwop-auth-oidc-user-bearer',
};

type Json = Record<string, unknown>;

export interface HostCapabilities extends Json {
  demoMode?: boolean;
  auth?: Json & { profiles?: string[] };
  feedback?: Json & { supported?: boolean; targets?: readonly string[]; signals?: readonly string[] };
  implementation?: { name?: string; version?: string; vendor?: string };
  extensions?: Record<string, Json | undefined>;
  capabilities?: Json;
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A v2 family as a v1 block: metadata stripped, presence restated as `supported: true`. */
function family(v: unknown): Json | undefined {
  if (!isObj(v)) return undefined;
  const out: Json = { supported: true };
  for (const [k, val] of Object.entries(v)) if (!FAMILY_META.has(k)) out[k] = val;
  return out;
}

/** A nested facet (`envelopes.reasoning`, `memory.attribution`) whose presence is its claim. */
function facet(parent: Json | undefined, key: string): void {
  if (parent && isObj(parent[key])) parent[key] = { supported: true, ...(parent[key] as Json) };
}

function profilesFromLanes(auth: unknown): string[] {
  const lanes = isObj(auth) && Array.isArray(auth.lanes) ? auth.lanes : [];
  const out: string[] = [];
  for (const l of lanes) {
    const p = isObj(l) && typeof l.lane === 'string' ? LANE_PROFILES[l.lane] : undefined;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function adaptV2Capabilities(doc: unknown): HostCapabilities {
  const v2: Json = isObj(doc) ? doc : {};
  const ext = isObj(v2.extensions) ? v2.extensions : {};
  const host = isObj(ext['openwop-app.host']) ? ext['openwop-app.host'] : {};
  const surfaces = isObj(ext['openwop-app.host-surfaces']) ? ext['openwop-app.host-surfaces'].surfaces : undefined;

  const auth = { ...(family(v2.auth) ?? {}), profiles: profilesFromLanes(v2.auth) };
  const envelopes = family(v2.envelopes);
  facet(envelopes, 'reasoning');
  const memory = family(v2.memory);
  facet(memory, 'attribution');
  const limits = family(v2.limits);
  if (limits) delete limits.supported;

  const families: Json = {
    auth,
    feedback: family(v2.feedback),
    prompts: family(v2.prompts),
    envelopes,
    memory,
    modelCapabilities: family(v2.modelCapabilities),
    aiProviders: family(v2.aiProviders),
    ...(Array.isArray(surfaces) ? { hostSurfaces: surfaces } : {}),
    ...(limits ? { limits } : {}),
  };
  for (const k of Object.keys(families)) if (families[k] === undefined) delete families[k];

  return {
    ...v2,
    ...families,
    demoMode: host.demoMode === true,
    capabilities: families,
  } as HostCapabilities;
}
