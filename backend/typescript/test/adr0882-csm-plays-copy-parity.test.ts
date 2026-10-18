/**
 * ADR 0882 D7 / CSM2UX-3 — the SPA's Plays card says how each play STARTS
 * ("bind the event" for an event-triggered chain, "run it / schedule it" for the
 * rest). That copy is chosen by the `trigger` field of `PLAYS` in `CsmPage.tsx`,
 * so it is only honest while that field matches the chain's real entry node.
 * The first cut told people to "set it up in the builder" for a chain that runs
 * only once its event is bound. This pins the two together.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

describe('CSM plays card ↔ csm-ops chain trigger parity', () => {
  it('every play the card lists names its chain\'s real trigger', () => {
    const page = readFileSync(join(ROOT, 'frontend', 'react', 'src', 'features', 'csm', 'CsmPage.tsx'), 'utf8');
    const pack = JSON.parse(readFileSync(join(ROOT, 'examples', 'workflow-chain-packs', 'csm-ops', 'pack.json'), 'utf8')) as {
      chains: Array<{ chainId: string; dag: { nodes: Array<{ typeId: string }> } }>;
    };
    const plays = [...page.matchAll(/\{ chainId: '([^']+)', key: '[^']+', trigger: '([^']+)' \}/g)].map((m) => ({ chainId: m[1]!, trigger: m[2]! }));
    expect(plays.length, 'the PLAYS table moved or changed shape — update this parse').toBe(2);
    for (const p of plays) {
      const chain = pack.chains.find((c) => c.chainId === p.chainId);
      expect(chain, `${p.chainId} is not in csm-ops`).toBeTruthy();
      const eventTriggered = chain!.dag.nodes.some((n) => n.typeId.startsWith('core.trigger.event@'));
      expect(p.trigger, p.chainId).toBe(eventTriggered ? 'event' : 'schedule');
    }
  });
});
