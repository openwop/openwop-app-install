/**
 * Agent-pack resolver — the manifest-agent parallel to `nodePackResolver.ts`
 * (RFC 0070). Scans the pack dir for `agents[]` arrays and loads them into
 * the AgentRegistry.
 *
 * Unlike nodes (lazily resolved when a workflow references a typeId), an
 * agent-only pack (`nodes: []`) has no node typeId to trigger a lazy load,
 * so we ALSO eager-load every local pack's agents at bootstrap. The lazy
 * resolver remains wired for packs installed after boot (hot-reload, RFC
 * 0003 §ImplNotes).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setAgentPackResolver } from '../executor/agentRegistry.js';
import { hydrateUserAgentIntoRegistry } from '../routes/userAgents.js';
import { loadAgentsFromManifest } from '../packs/agentLoader.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { isParkedPackDirName } from './mountLocalPacks.js';
import { createLogger } from '../observability/logger.js';
import { agentsCapability, stripSupported } from '../routes/discovery.js';
import { storageFamilyFacets, v2AdvertisedStorageFamilies } from '../host/storageFamilyAdvert.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('bootstrap.agentPackResolver');
const PACK_DIR = resolveDefaultPackDir();

/**
 * Capability keys this reference host satisfies for RFC 0072 §C agent-pack
 * peer-dependency resolution. The workflow-engine host implements the
 * `agents.manifestRuntime` floor (RFC 0070) and dispatches to AI providers; it
 * does NOT advertise the heavyweight `host.agentRuntime` swarm surface. A
 * production host would derive this set from its own advertised capabilities.
 */
// `host.connectors` added per ADR 0037: the connectorInvoker host slot is now a
// real broker-delegating impl (no longer throw-on-use), so a pack declaring
// `peerDependencies:["host.connectors"]` resolves here instead of getting
// host_capability_missing. Honesty: we only list a capability whose host slot is
// actually wired — see hostSurfaceRegistry `host.connectors` supported:true.
const HOST_SATISFIED_CAPS = new Set<string>(['agents.manifestRuntime', 'aiProviders', 'host.connectors']);

/**
 * NP-V2-7 — the v2 peer-dependency identifiers (a `spec/v2/declaration.json`
 * family key, facets named in `peerDependenciesMeta.<family>.facets`) this host
 * satisfies. The v1 keys above are the legacy spelling; since the P0 re-vendor
 * the core agent packs declare the v2 spelling (`agentRuntime`, `agents` +
 * `memoryBackends`), which the v1-only set could not read at all.
 *
 * The rule is the one `capabilities.md` §2 states for the wire: a family is
 * satisfied iff this host ADVERTISES it on the v2 discovery document, and a
 * facet iff that family's record carries it. MEASURED 2026-09-28: of the
 * families agent packs ask for, the v2 document advertised `aiProviders` only;
 * `agentRuntime`, `fs` and `queueBus` were not advertised (`queueBus` is since
 * ADR 0858 P3), so claiming
 * them here would be a dishonest satisfaction.
 *
 * CORRECTED 2026-09-28: `agents` IS advertised at v2 now (#4198 moved the v1
 * block into `agentsCapability()`, one owner for both majors). The table this
 * replaced was static and said "not advertised", so main went red the moment
 * both landed; the parity test's own message said to widen it deliberately.
 * It is a FUNCTION now, because the `agents` facets are conditional:
 * `memoryBackends` exists only on durable memory, `proposals`/`goals` only
 * behind their toggles. A static set would claim a facet the document may not
 * carry. The facets are read from the same owner the advertisement is built
 * from, with `supported` stripped as on the wire, so the two cannot disagree.
 * `test/agent-peer-satisfaction-parity.test.ts` pins this to
 * `buildV2Advertisement`.
 */
export function v2SatisfiedFamilies(): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map<string, ReadonlySet<string>>([
    ['aiProviders', new Set<string>()],
    ['agents', new Set(Object.keys(stripSupported(agentsCapability())))],
    // ADR 0858 P3 — the storage families v2 advertises, from the same builder
    // and the same list. A facet is satisfied only when its value is not `false`.
    ...v2AdvertisedStorageFamilies().map((family): [string, ReadonlySet<string>] => [
      family,
      new Set(Object.entries(storageFamilyFacets()[family]).filter(([, v]) => v !== false).map(([k]) => k)),
    ]),
  ]);
}

export function hostSatisfies(cap: string, facets: readonly string[] = []): boolean {
  if (HOST_SATISFIED_CAPS.has(cap) && facets.length === 0) return true;
  const family = v2SatisfiedFamilies().get(cap);
  return family !== undefined && facets.every((f) => family.has(f));
}

/** Eager-load every local pack's `agents[]` into the AgentRegistry. The §C
 *  disposition runs (computing each agent's `degraded[]` for unmet OPTIONAL
 *  tiers); `strict` is left off so the eager pass loads regardless of a
 *  required-unmet tier (the 21-pack peerDep migration is the sequenced tier). */
export function loadAllLocalAgents(): number {
  if (!existsSync(PACK_DIR)) return 0;
  let total = 0;
  for (const entry of readdirSync(PACK_DIR)) {
    if (isParkedPackDirName(entry)) continue; // shadow-pass leftovers are recoverable, never loadable
    const manifestPath = join(PACK_DIR, entry, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    try {
      total += loadAgentsFromManifest(join(PACK_DIR, entry), { hostSatisfies }).length;
    } catch (err) {
      log.warn('failed to load agents from pack', {
        path: manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (total > 0) log.info('eager-loaded manifest agents at bootstrap', { count: total });
  return total;
}

export function ensureAgentPackResolverInstalled(storage: Storage): void {
  // Lazy resolver — handles a registry miss for both user-authored agents and
  // packs installed after boot.
  setAgentPackResolver(async (agentId, tenant) => {
    // User-authored / seeded agents live in durable storage, NOT the pack dir.
    // The registry is boot-hydrated (not read-through), so on an instance that
    // booted before the agent was created/seeded it's absent from the in-process
    // map though present in storage. Hydrate it first so `resolve()` re-reads it
    // — this closes the multi-instance gap for chat-callable seeded personas.
    // ADR 0379 P2: the tenant rides the resolve call, so the hydrate read is
    // tenant-scoped whenever a tenant is known.
    if (await hydrateUserAgentIntoRegistry(storage, agentId, tenant)) return null;
    if (!existsSync(PACK_DIR)) return null;
    for (const entry of readdirSync(PACK_DIR)) {
      if (isParkedPackDirName(entry)) continue;
      const manifestPath = join(PACK_DIR, entry, 'pack.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (Array.isArray(manifest.agents) && manifest.agents.some((a: { agentId?: string }) => a.agentId === agentId)) {
          loadAgentsFromManifest(join(PACK_DIR, entry), { hostSatisfies });
          return null; // registry re-read by the caller (getAgentRegistry().resolve)
        }
      } catch (err) {
        log.warn('failed to scan pack manifest for agent', {
          path: manifestPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return null;
  });
  // Eager pass so agent-only packs + the inventory route are populated now.
  loadAllLocalAgents();
}
