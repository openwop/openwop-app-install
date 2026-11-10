/**
 * ADR 1033 D2 — the tenant-scoped store of packs installed by `applyProposal`
 * (RFC 0253). Host-installed packs (vendored, registry) are process-global and
 * filesystem-based; a pack a tenant's reviewer applied is neither, so it lives
 * here, keyed by `(tenant, name)`, one version per name (RFC 0253 UQ 4).
 *
 * The row keeps the applied `pack.json` exactly as reviewed: `getInstalledPack`
 * serves `manifest` unchanged, and the RFC 0253 host-owned field set is empty, so
 * nothing host-owned may be written into it. Install metadata (source proposal,
 * time) sits beside it on the row, never inside it.
 *
 * In `host/` (not the proposals feature) because core readers resolve what a
 * tenant installed: the chain gallery and `from-chain` (chain packs), and the
 * agent registry's miss path and the agent inventory (agent packs, P2).
 */

import { DurableCollection } from './hostExtPersistence.js';
import { normalizeChainPins } from './chainPinRule.js';
import { getChain, type SubChainDeps, type WorkflowChain } from './workflowChainPackLoader.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';

export type InstalledPackKind = 'workflow-chain-pack' | 'agent-pack';

export interface TenantInstalledPack {
  key: string;
  tenantId: string;
  name: string;
  kind: InstalledPackKind;
  version: string;
  /** The applied artifact, verbatim. Served as-is by `getInstalledPack`. */
  manifest: Record<string, unknown>;
  proposalId: string;
  installedAt: string;
}

const rows = new DurableCollection<TenantInstalledPack>('proposals:installed-packs', (r) => r.key, undefined, (r) => r.tenantId);

const keyOf = (tenant: string, name: string): string => `${tenant}::${name}`;

/** The installed row for `name` in `tenant`, or null. Another tenant's row is never read. */
export async function getTenantInstalledPack(tenant: string, name: string): Promise<TenantInstalledPack | null> {
  const row = await rows.get(keyOf(tenant, name));
  return row && row.tenantId === tenant ? row : null;
}

export async function listTenantInstalledPacks(tenant: string): Promise<TenantInstalledPack[]> {
  return (await rows.listForTenantIndexed(tenant)).filter((r) => r.tenantId === tenant);
}

/**
 * Write `next` only if the stored row is still `expected` (null = absent). Returns
 * an undo that restores `expected`, or null when another write won.
 */
export async function swapTenantInstalledPack(
  expected: TenantInstalledPack | null,
  next: Omit<TenantInstalledPack, 'key'>,
): Promise<(() => Promise<void>) | null> {
  const row: TenantInstalledPack = { key: keyOf(next.tenantId, next.name), ...next };
  if (!(await rows.compareAndSwap(expected, row))) return null;
  return async () => {
    if (expected) await rows.compareAndSwap(row, expected);
    else await rows.compareAndDelete(row);
  };
}

// ── chain packs ──────────────────────────────────────────────────────────────

type InstalledChain = { packName: string; packVersion: string; chain: WorkflowChain };

function chainsOf(row: TenantInstalledPack): InstalledChain[] {
  if (row.kind !== 'workflow-chain-pack' || !Array.isArray(row.manifest['chains'])) return [];
  return (row.manifest['chains'] as WorkflowChain[]).map((authored) => {
    const normalized = normalizeChainPins(authored);
    const chain: WorkflowChain = Object.keys(normalized.nodePins).length > 0
      ? { ...normalized.chain, nodePins: normalized.nodePins }
      : normalized.chain;
    return { packName: row.name, packVersion: row.version, chain };
  });
}

/** Every chain the tenant's installed chain packs contribute, pins normalized as the loader does. */
export async function listTenantInstalledChains(tenant: string): Promise<InstalledChain[]> {
  return (await listTenantInstalledPacks(tenant)).flatMap(chainsOf);
}

/** One installed chain by id in `tenant`, or null. */
export async function getTenantInstalledChain(tenant: string, chainId: string): Promise<InstalledChain | null> {
  return (await listTenantInstalledChains(tenant)).find((e) => e.chain.chainId === chainId) ?? null;
}

/**
 * ADR 1033 P2 — how a tenant chain's sub-chains resolve at instantiation (ADR 0959
 * D2's resolver seam). A sibling ref resolves in the SAME installed pack, never the
 * host map; an external ref resolves only at the exact `{packName, chainId,
 * version}` it names, in a host pack or another pack this tenant installed.
 */
export async function installedChainResolution(tenant: string, packName: string): Promise<Pick<SubChainDeps, 'resolveSibling' | 'resolveExternal'>> {
  const all = await listTenantInstalledChains(tenant);
  return {
    resolveSibling: (ref) => all.find((e) => e.packName === packName && e.chain.chainId === ref)?.chain ?? null,
    resolveExternal: (ref) => {
      const host = getChain(ref.chainId);
      if (host && host.packName === ref.packName && host.chain.version === ref.version) return host.chain;
      return all.find((e) => e.packName === ref.packName && e.chain.chainId === ref.chainId && e.chain.version === ref.version)?.chain ?? null;
    },
  };
}

// ── agent packs (ADR 1033 P2) ────────────────────────────────────────────────

interface RawInstalledAgent {
  agentId: string;
  persona: string;
  modelClass: string;
  systemPrompt: string;
  label?: unknown;
  description?: unknown;
  toolAllowlist?: unknown;
  memoryShape?: unknown;
  confidence?: unknown;
}

/**
 * The registry entries an installed agent pack contributes. Tenant-owned, as a
 * user-authored agent is (`ownerTenant`), so every visibility and dispatch gate
 * that hides one tenant's agents from another applies unchanged. The prompt is
 * the inline `systemPrompt` (RFC 0253 §D allows no ref), and no handoff schema or
 * eval suite is resolved: the pack carries none.
 */
export function projectInstalledPackAgents(row: TenantInstalledPack): ResolvedAgentManifest[] {
  if (row.kind !== 'agent-pack' || !Array.isArray(row.manifest['agents'])) return [];
  return (row.manifest['agents'] as RawInstalledAgent[]).map((a) => ({
    agentId: a.agentId,
    persona: a.persona,
    modelClass: a.modelClass,
    systemPrompt: a.systemPrompt,
    ...(typeof a.label === 'string' ? { label: a.label } : {}),
    ...(typeof a.description === 'string' ? { description: a.description } : {}),
    toolAllowlist: Array.isArray(a.toolAllowlist) ? a.toolAllowlist.filter((t): t is string => typeof t === 'string') : [],
    ...(a.memoryShape && typeof a.memoryShape === 'object' ? { memoryShape: a.memoryShape as ResolvedAgentManifest['memoryShape'] } : {}),
    ...(a.confidence && typeof a.confidence === 'object' ? { confidence: a.confidence as ResolvedAgentManifest['confidence'] } : {}),
    packName: row.name,
    packVersion: row.version,
    ownerTenant: row.tenantId,
  }));
}

/** Every agent the tenant's installed agent packs contribute. */
export async function listTenantInstalledAgents(tenant: string): Promise<ResolvedAgentManifest[]> {
  return (await listTenantInstalledPacks(tenant)).flatMap(projectInstalledPackAgents);
}

/**
 * The agent registry's miss path: register `agentId` if a pack installed in
 * `tenant` contributes it. Returns whether it did. On an instance that did not
 * run the apply, this is how the agent becomes resolvable; a TTL re-read through
 * the same path drops it once its pack is gone or replaced.
 */
export async function hydrateInstalledPackAgent(agentId: string, tenant: string | undefined): Promise<boolean> {
  if (tenant === undefined || tenant === '*') return false;
  const hit = (await listTenantInstalledAgents(tenant)).find((a) => a.agentId === agentId);
  if (!hit) return false;
  getAgentRegistry().register(hit);
  return true;
}
