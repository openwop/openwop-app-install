/**
 * ADR 0616 — the CHAIN-EMBED-1 marker must reach DEFERRED mode too.
 *
 * ADR 0507 stopped a missing REQUIRED embedded `{{params.x}}` from freezing to
 * `''` by degrading it to `[missing: x]`. The `requiredNames` argument that arms
 * that is optional, and the two DEFERRED call sites
 * (`workflowChainPackLoader.ts` `materializeInputs` / `deferredConfig`) did not
 * pass it — so deferred mode kept the original bug for every position it cannot
 * actually defer, which is everything outside `LIFTABLE_PROMPT_BODY_KEYS`
 * (`systemPrompt`, `userPrompt`) and whole-value input tokens.
 *
 * That is worse than an ordinary gap because deferred mode is the remediation
 * `TODO.md` recommends for this very class.
 *
 * The `config.key` rows are the sharp ones: that is a KV key, so `seen:` is not a
 * degraded key but a SHARED one — every deferred instantiation reads and writes
 * the same row.
 *
 * This asserts MODE AGREEMENT, not a literal string: whatever the marker looks
 * like, both modes must produce the same thing for the same absent param. A test
 * pinned to `[missing: x]` would pass if someone changed the marker in one mode
 * only, which is the exact defect being fixed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { MISSING_REQUIRED_MARKER } from '../src/host/tokenSubstitution.js';

const PACK_ROOT = join(import.meta.dirname, '../../../examples/workflow-chain-packs');
beforeAll(() => { _resetChainRegistryForTest(); loadWorkflowChainPacks({ roots: [PACK_ROOT] }); });

/** Chain, authored node id, bucket, key, and the REQUIRED param embedded there.
 *  Derived by scanning both pack roots for an embedded required token in a
 *  NON-liftable position; `packs/` contributes none. */
const LOCATIONS: ReadonlyArray<readonly [string, string, 'config' | 'inputs', string, string]> = [
  ['devops.stale-issues',        'fetch',    'config', 'url',     'repo'],
  // ADR 0643 D5 removed `finance.month-end-close`.`docs`.config.query — the key
  // was INERT (`packs/feature.kb.nodes/index.mjs` never reads `ctx.config`), so
  // the position it inventoried no longer exists. `deferredConfig` coverage is
  // unchanged: eight other `config`-bucket rows below still exercise it.
  ['it-support.incident-triage', 'ticket',   'config', 'summary', 'alert'],
  ['people-hr.onboarding',       'tickets',  'config', 'summary', 'newHireName'],
  ['support.ticket-routing',     'ticket',   'config', 'summary', 'requestText'],
  ['content.feed-watch',         'seen',     'config', 'key',     'feedUrl'],
  ['content.feed-watch',         'remember', 'config', 'key',     'feedUrl'],
  ['content.page-watch',         'snapshot', 'config', 'key',     'pageUrl'],
  ['content.page-watch',         'remember', 'config', 'key',     'pageUrl'],
  // The `inputs` bucket is a SEPARATE call site (`materializeInputs`) from
  // `config` (`deferredConfig`). Omitting these rows is how the first draft of
  // this test passed while `materializeInputs` was still unfixed — sabotage
  // caught it. Two arguments, two coverages.
  ['content.feed-watch',         'seen',     'inputs', 'key',     'feedUrl'],
  ['content.feed-watch',         'remember', 'inputs', 'key',     'feedUrl'],
  ['content.page-watch',         'snapshot', 'inputs', 'key',     'pageUrl'],
  ['content.page-watch',         'remember', 'inputs', 'key',     'pageUrl'],
];

const chainById = (id: string) => {
  const found = listChains().find((c) => c.chain.chainId === id);
  expect(found, `chain ${id} not loaded — renamed or moved?`).toBeDefined();
  return found!.chain;
};

/** The value at one authored position. Expansion PREFIXES node ids, so match on
 *  the authored suffix rather than equality. */
function valueAt(def: unknown, nodeId: string, bucket: 'config' | 'inputs', key: string): unknown {
  const nodes = (def as { nodes?: Array<Record<string, any>> }).nodes ?? [];
  const node = nodes.find((n) => String(n.nodeId).endsWith(`_${nodeId}`));
  expect(node, `node '*_${nodeId}' not in the expansion — id scheme changed?`).toBeDefined();
  return (node as any)[bucket]?.[key];
}

describe('ADR 0616 — deferred expansion marks a missing REQUIRED embedded param', () => {
  it.each(LOCATIONS)(
    '%s.%s %s.%s — deferred agrees with non-deferred about the missing %s',
    (chainId, nodeId, bucket, key, param) => {
      const chain = chainById(chainId);
      const plain = valueAt(expandChain(chain, { params: {} }), nodeId, bucket, key);
      const deferred = valueAt(expandChain(chain, { deferred: true, params: {} }), nodeId, bucket, key);

      // Control: the non-deferred side must actually carry the marker, or this
      // whole comparison is vacuous — two modes can agree by both being wrong.
      expect(plain, `${chainId}.${key}: non-deferred lost the ADR 0507 marker, so this test proves nothing`)
        .toContain(MISSING_REQUIRED_MARKER(param));

      expect(deferred, `${chainId}.${key}: deferred mode dropped '${param}' silently`).toBe(plain);
    },
  );

  it('ADR 0622 D3 — the WHOLE-VALUE required position (people-hr.onboarding invite-host config.email = {{params.newHireEmail}}) agrees in both modes: dropped when unset, the value when set', () => {
    // A whole-value token is NOT an embedded one: with no value it freezes to
    // `undefined` (the key vanishes) rather than to the marker, and the node's
    // typed refusal is what catches it. Both modes must agree either way.
    const chain = chainById('people-hr.onboarding');
    expect(valueAt(expandChain(chain, { params: {} }), 'invite-host', 'config', 'email')).toBeUndefined();
    expect(valueAt(expandChain(chain, { deferred: true, params: {} }), 'invite-host', 'config', 'email')).toBeUndefined();
    const params = { newHireName: 'Sam', newHireEmail: 'sam@acme.test' };
    for (const mode of [{ params }, { deferred: true as const, params }]) {
      expect(valueAt(expandChain(chain, mode), 'invite-host', 'config', 'email')).toBe('sam@acme.test');
    }
  });

  it('a supplied param still produces a clean value in BOTH modes — no marker anywhere', () => {
    const chain = chainById('devops.stale-issues');
    const params = { repo: 'openwop/openwop-app' };
    const plain = String(valueAt(expandChain(chain, { params }), 'fetch', 'config', 'url'));
    const deferred = String(valueAt(expandChain(chain, { deferred: true, params }), 'fetch', 'config', 'url'));
    for (const [label, v] of [['non-deferred', plain], ['deferred', deferred]] as const) {
      expect(v, `${label} marked a param that HAS a value`).not.toContain('[missing:');
      expect(v, `${label} did not substitute the value`).toContain('openwop/openwop-app');
    }
  });

  it('the KV-key case: the fix makes the shared key VISIBLE, it does not un-share it', () => {
    // Honest scope. `config.key` is a KV key, so a missing `feedUrl` gives every
    // deferred instantiation the SAME key — one tenant's seen-set is another's.
    // Marking it does not separate them: the position is frozen, so no run-time
    // value can arrive. Two instantiations still collide. What changes is that the
    // key is now greppably wrong instead of looking like a valid namespace prefix.
    const chain = chainById('content.feed-watch');
    const missingKey = (): string =>
      String(valueAt(expandChain(chain, { deferred: true, params: {} }), 'seen', 'config', 'key'));

    expect(missingKey(), 'still shared — this is the documented limit of ADR 0616, not a regression')
      .toBe(missingKey());
    expect(missingKey(), 'but it must no longer look like a valid key')
      .toContain(MISSING_REQUIRED_MARKER('feedUrl'));

    // And the working case is untouched: distinct feeds get distinct keys.
    const keyFor = (feedUrl: string): string =>
      String(valueAt(expandChain(chain, { deferred: true, params: { feedUrl } }), 'seen', 'config', 'key'));
    expect(keyFor('https://a.example/rss')).not.toBe(keyFor('https://b.example/rss'));
  });
});
