/**
 * A `core.flow.if` node whose `value` input is never populated ALWAYS takes the
 * `else` branch — silently. Nothing throws, the run completes, and the `then`
 * half of the chain is unreachable dead content.
 *
 * Four shipped chains had exactly that shape. The mechanism (verified in
 * `executor/scheduler.ts` and `packs/core.openwop.flow/index.mjs`):
 *
 *   - a portless edge `{from:'a', to:'b'}` lands its payload on the target port
 *     `input` (`scheduler.ts`: `const targetPort = e.targetInput ?? 'input'`);
 *   - `ifNode` reads `ctx.inputs.value` — NOT `ctx.inputs.input`;
 *   - so `value` is `undefined`, `resolvePath(undefined, path)` is `undefined`,
 *     and every predicate op returns false for `undefined` (`contains` and
 *     `truthy` both do), yielding `branch: 'else'` on every run.
 *
 * The damage was per-chain and user-visible: `starters.verified-webhook-router`
 * DROPPED every webhook it had just verified as valid; `support.kb-answer` never
 * delivered a high-confidence answer; `support.sentiment-escalation` escalated
 * every message regardless of brand risk; `marketing.ad-optimization` never
 * auto-applied a change inside its guardrail.
 *
 * ADR 0498 §Open items had already fixed these nodes' EMPTY `config` (a hard
 * TypeError). That fix made them run — it did not make them branch. A crash is
 * loud; this is not. Hence a ratchet rather than a one-time audit.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const PACK_DIRS = ['examples/workflow-chain-packs', 'packs'];

interface Node { id: string; typeId?: string; inputs?: Record<string, unknown>; config?: Record<string, unknown> }
interface Edge { from: string; to: string }
interface Chain { chainId: string; dag?: { nodes?: Node[]; edges?: Edge[] } }

function chainPacks(): { file: string; chains: Chain[] }[] {
  const out: { file: string; chains: Chain[] }[] = [];
  for (const dir of PACK_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      const file = join(abs, entry, 'pack.json');
      if (!existsSync(file)) continue;
      let parsed: { chains?: Chain[] };
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      if (parsed.chains?.length) out.push({ file: `${dir}/${entry}/pack.json`, chains: parsed.chains });
    }
  }
  return out;
}

/** The port an edge targets — `nodeId.port`, defaulting to `input` (scheduler.ts). */
function targetPort(to: string): string {
  const dot = to.indexOf('.');
  return dot === -1 ? 'input' : to.slice(dot + 1);
}
function targetNode(to: string): string {
  const dot = to.indexOf('.');
  return dot === -1 ? to : to.slice(0, dot);
}

const PACKS = chainPacks();
const BRANCH_NODES = PACKS.flatMap(({ file, chains }) =>
  chains.flatMap((ch) =>
    (ch.dag?.nodes ?? [])
      .filter((n) => n.typeId === 'core.flow.if')
      .map((n) => ({
        where: `${file} :: ${ch.chainId} :: ${n.id}`,
        node: n,
        inboundPorts: (ch.dag?.edges ?? []).filter((e) => targetNode(e.to) === n.id).map((e) => targetPort(e.to)),
      })),
  ),
);

describe('the scan reaches a real corpus (a vacuous scan would pass forever)', () => {
  it('finds chain packs and at least one core.flow.if node', () => {
    expect(PACKS.length, 'no chain packs found — the ratchet is scanning nothing').toBeGreaterThan(5);
    expect(BRANCH_NODES.length, 'no core.flow.if nodes found — the ratchet is vacuous').toBeGreaterThan(0);
  });
});

describe('every core.flow.if node can actually take its `then` branch', () => {
  it('the predicate input `value` is populated by an edge or a declared input', () => {
    const dead = BRANCH_NODES
      .filter(({ node, inboundPorts }) => !inboundPorts.includes('value') && !('value' in (node.inputs ?? {})))
      .map(({ where, inboundPorts }) => `${where} (inbound ports: ${inboundPorts.join(', ') || 'none'})`);
    expect(dead, 'these branch nodes read ctx.inputs.value, which nothing populates — they always take `else`').toEqual([]);
  });

  it('has a predicate to evaluate at all (an empty config is a hard TypeError — ADR 0498)', () => {
    const noPredicate = BRANCH_NODES
      .filter(({ node }) => !(node.config as { predicate?: unknown } | undefined)?.predicate)
      .map(({ where }) => where);
    expect(noPredicate).toEqual([]);
  });
});
