/**
 * ADR 0959 D2 — versioned sub-chain resolution for a playbook (closes P-G2).
 *
 * The chain loader's `coRegisterSubChains` resolves through `SubChainDeps` hooks; this builds
 * them for one install. Resolution is EXACT, in order:
 *  1. a slot binding of the root version (D3) — the bound playbook version's chain;
 *  2. a sibling string ref → the `chains[]` of the version that OWNS the parent chain;
 *  3. an external `{packName: 'playbook:<id>', chainId, version}` → that playbook version of the
 *     SAME tenant;
 *  4. an external host-pack ref → the global registry ONLY when its loaded pack name AND chain
 *     version equal the requested ones.
 * Anything else resolves to null, which the loader refuses `sub_chain_unresolved` — never the
 * host's newest copy. Every read is tenant-scoped, so a ref can never reach another tenant.
 *
 * Children are minted per (tenant, playbook, version, chainId): tenant-authored chain ids can
 * repeat across playbooks with different content, and the shared-child convergence would
 * otherwise refresh one playbook's child with another's definition. Two clients installing the
 * same version still share a child (D4).
 */
import { getChain, mintChildWorkflowId, type SubChainDeps, type WorkflowChain } from '../../host/workflowChainPackLoader.js';
import { getVersion } from './playbookStore.js';
import type { PlaybookVersion, SlotBinding } from './types.js';

export const PLAYBOOK_REF_PREFIX = 'playbook:';

export type PlaybookResolution = Required<Pick<SubChainDeps, 'resolveSibling' | 'resolveExternal' | 'mintChildId'>>;

export function playbookResolution(tenantId: string, root: PlaybookVersion, slotBindings: Record<string, SlotBinding> = {}): PlaybookResolution {
  const owner = new WeakMap<WorkflowChain, PlaybookVersion>();
  const hostPack = new WeakMap<WorkflowChain, string>();
  for (const c of root.chains) owner.set(c, root);

  const fromVersion = async (playbookId: string, version: string, chainId: string): Promise<WorkflowChain | null> => {
    const v = await getVersion(tenantId, playbookId, version);
    const chain = v?.chains.find((c) => c.chainId === chainId) ?? null;
    if (v && chain) owner.set(chain, v);
    return chain;
  };
  const boundSlot = (ref: string, parent: WorkflowChain): SlotBinding | undefined =>
    (owner.get(parent) === root ? slotBindings[ref] : undefined);

  return {
    async resolveSibling(ref, parent) {
      const slot = boundSlot(ref, parent);
      if (slot) return fromVersion(slot.playbookId, slot.version, slot.chainId);
      const v = owner.get(parent);
      if (v) {
        const chain = v.chains.find((c) => c.chainId === ref) ?? null;
        if (chain) owner.set(chain, v);
        return chain;
      }
      // A host-pack chain's own sibling: that pack only, at whatever the host loaded.
      const pack = hostPack.get(parent);
      const found = pack ? getChain(ref) : null;
      if (found && found.packName === pack) { hostPack.set(found.chain, pack); return found.chain; }
      return null;
    },
    async resolveExternal(ref, parent) {
      const slot = boundSlot(ref.chainId, parent);
      if (slot) return fromVersion(slot.playbookId, slot.version, slot.chainId);
      if (ref.packName.startsWith(PLAYBOOK_REF_PREFIX)) {
        return fromVersion(ref.packName.slice(PLAYBOOK_REF_PREFIX.length), ref.version, ref.chainId);
      }
      const found = getChain(ref.chainId);
      if (!found || found.packName !== ref.packName || found.chain.version !== ref.version) return null;
      hostPack.set(found.chain, found.packName);
      return found.chain;
    },
    mintChildId(tid, child) {
      const v = owner.get(child);
      return v
        ? mintChildWorkflowId(tid, `playbook.${v.playbookId}.${v.version}.${child.chainId}`, child.version)
        : mintChildWorkflowId(tid, child.chainId, child.version);
    },
  };
}

/** Every `subChainRef` value a chain's nodes use. */
export function subChainRefsOf(chain: WorkflowChain): string[] {
  const refs = new Set<string>();
  for (const n of chain.dag.nodes) {
    const r = (n.config as Record<string, unknown> | undefined)?.subChainRef;
    if (typeof r === 'string') refs.add(r);
  }
  return [...refs];
}

/**
 * Resolve every ref reachable from the entry chain, depth-first, without writing anything.
 * Returns the first ref that does not resolve, or null. Used at publish (refuse a version whose
 * refs do not resolve today) and at install (refuse a slot binding that does not resolve).
 */
export async function firstUnresolvedRef(resolution: PlaybookResolution, entry: WorkflowChain): Promise<string | null> {
  const seen = new Set<WorkflowChain>();
  const walk = async (chain: WorkflowChain, depth: number): Promise<string | null> => {
    if (seen.has(chain) || depth > 8) return null;
    seen.add(chain);
    for (const ref of subChainRefsOf(chain)) {
      const ext = (chain.subChains ?? []).map((s) => s.ref).find((r) => typeof r === 'object' && r.chainId === ref);
      const child = ext && typeof ext === 'object' ? await resolution.resolveExternal(ext, chain) : await resolution.resolveSibling(ref, chain);
      if (!child) return ref;
      const deeper = await walk(child, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(entry, 0);
}
