/**
 * `core.openwop.integration.notification-push` MUST NOT appear in a chain pack.
 *
 * Its input schema requires `deviceToken` — a per-recipient RUNTIME value no chain
 * author can know. 55 nodes across 53 chains left it unbound, so the Expo adapter
 * POSTed `to: undefined`, errored, and the node returned `status:'success'` with
 * `sent:false`: a run whose only outbound action failed completed GREEN.
 *
 * The node itself is NOT deleted — it is a real device-push capability with real
 * infrastructure behind it (`host/notificationAdapter.ts` brokers Expo egress over
 * a Connection, and `toolCapabilityResolver` assigns it a safetyTier). A caller
 * that genuinely holds a device token may use it. What must never happen again is
 * a CHAIN reaching for it, because a chain can never satisfy its contract.
 *
 * Chains want `feature.notifications.nodes.notify` — the host-owned in-app node
 * over the single emitter, whose audience is authoring-time config and which
 * therefore has no unbindable input.
 *
 * ZERO baseline, not a ceiling: unlike the counts this file's siblings ratchet,
 * there is no legitimate instance to grandfather.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const PACK_DIRS = ['examples/workflow-chain-packs', 'packs'];
const FORBIDDEN = 'core.openwop.integration.notification-push';
const REPLACEMENT = 'feature.notifications.nodes.notify';

interface Node { id: string; typeId?: string }
interface Chain { chainId: string; dag?: { nodes?: Node[] } }

const chains: { where: string; chain: Chain }[] = [];
for (const dir of PACK_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs)) {
    const file = join(abs, entry, 'pack.json');
    if (!existsSync(file)) continue;
    let parsed: { chains?: Chain[] };
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const chain of parsed.chains ?? []) chains.push({ where: `${dir}/${entry}`, chain });
  }
}

describe('the scan reaches a real corpus', () => {
  it('finds chains to inspect', () => {
    expect(chains.length, 'no chains found — the ratchet is scanning nothing').toBeGreaterThan(50);
  });
});

describe('notification-push is forbidden in chains', () => {
  it('no chain node uses it — a chain can never bind its required deviceToken', () => {
    const offenders = chains.flatMap(({ where, chain }) =>
      (chain.dag?.nodes ?? [])
        .filter((n) => n.typeId === FORBIDDEN)
        .map((n) => `${where} :: ${chain.chainId} :: ${n.id}`));
    expect(
      offenders,
      `use \`${REPLACEMENT}\` instead — its audience is authoring-time config, so it has no unbindable input`,
    ).toEqual([]);
  });

  it('the replacement is actually in use — proving this is a retarget, not a deletion', () => {
    const used = chains.flatMap(({ chain }) =>
      (chain.dag?.nodes ?? []).filter((n) => n.typeId === REPLACEMENT));
    expect(used.length, 'the 55 retargeted nodes should be here').toBeGreaterThan(50);
  });

  it('every replacement node names an audience — it is never inferred from the run', () => {
    const unbound = chains.flatMap(({ chain }) =>
      (chain.dag?.nodes ?? [])
        .filter((n) => n.typeId === REPLACEMENT)
        .filter((n) => !((n as unknown as { config?: { audience?: unknown } }).config?.audience))
        .map((n) => `${chain.chainId} :: ${n.id}`));
    expect(unbound, '`audience` is required config: self / tenant / role:<name>').toEqual([]);
  });
});
