/**
 * Shipped node-typeId derivation for chain-pack tests (CI-baseline fix).
 *
 * The chain tests used to pin hard-coded KNOWN_TYPEIDS lists, which silently
 * drifted when packs renamed nodes (#1149's connector vendor grouping moved
 * exec-ops onto `core.openwop.connectors.*` and the lists were never updated,
 * poisoning every local `npm run ci` with 20+ "pre-existing" failures).
 * Deriving the set from the pack manifests on disk — the same approach
 * `crm-packs.test.ts` established — makes drift impossible: a chain
 * referencing a typeId no shipped manifest declares is a REAL failure.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKS_DIR = join(__dirname, '..', '..', '..', 'packs');

/**
 * TRUE host-resolvable check: a typeId resolves if a shipped pack manifest
 * declares it OR the host registers it as a BUILT-IN (`bootstrap/nodes.ts` —
 * the ADR 0186 `core.openwop.connectors.*` family lives there, not in packs/,
 * which is exactly what the stale hard-coded lists missed).
 */
export async function isHostResolvableTypeId(): Promise<(typeId: string) => boolean> {
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
  ensureNodesRegistered();
  const registry = getNodeRegistry();
  const shipped = shippedNodeTypeIds();
  return (typeId: string) => registry.has(typeId) || shipped.has(typeId);
}

/** Every node typeId declared by any shipped pack manifest under packs/. */
export function shippedNodeTypeIds(): Set<string> {
  const out = new Set<string>();
  for (const dir of readdirSync(PACKS_DIR)) {
    const manifestPath = join(PACKS_DIR, dir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: { nodes?: Array<{ typeId?: string }> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { nodes?: Array<{ typeId?: string }> };
    } catch {
      continue; // a malformed manifest is another test's failure, not this one's
    }
    for (const n of manifest.nodes ?? []) {
      if (typeof n.typeId === 'string') out.add(n.typeId);
    }
  }
  return out;
}
