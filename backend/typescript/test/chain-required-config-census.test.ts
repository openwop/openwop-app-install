/**
 * GEN-IS-1 / WF-KB-6 (ADR 0599 §4) — the CORPUS-WIDE form of `PROBE-DOC-4`.
 *
 * `PROBE-DOC-4` was written for the class "a chain node that cannot succeed as
 * authored", then scoped to `feature.documents.nodes.*` — the one instance already
 * removed. It went vacuous, and five live instances of the identical defect shipped
 * in the very pack it lives beside. Scoping a cure to the instance is what let the
 * class survive a rebuild AND a migration.
 *
 * So the rule is applied to **every chain in every vendored chain pack**, not one
 * namespace and not one feature.
 *
 * ── The measured blast radius, and WHAT THE MEASUREMENT COVERS ──────────────
 *
 * **This is a FLOOR over a hand-named table, not a corpus audit** — and stating
 * the denominator is the point, because the first version of this file quoted
 * "**6 of 179 chains across 58 packs**" as if it were a corpus figure. It is not.
 * MEASURED: the corpus is **584 chain-node instances across 175 distinct
 * typeIds**; the table below matches **15** of them — about **2.5%** — and five
 * of the original nine matches were `insights-suite`'s own nodes. A number that
 * small is a floor, and *`PROBE-DOC-4`'s narrowing reproduced one level up* is
 * exactly what quoting it as coverage would be.
 *
 * So the anti-vacuity floor below counts matches on chains this feature does NOT
 * own. The original `matched > 5` was satisfiable by `insights-suite` alone.
 *
 * Everything the table names and finds is real: **6 starved nodes outside this
 * feature**, all QUARANTINED by name rather than repaired in a feature-27 change
 * — a cross-feature fix inside a scoped PR is how a "measurement" turns into an
 * unreviewed corpus edit. They are two shapes:
 *
 *  1. Three `core.email.draft` nodes with `config:{}`. Same structural cure:
 *     `core.email.draft` is code-registered in `bootstrap/nodes.ts` with **no
 *     pack manifest**, therefore no `configSchemaRef`, therefore the chain
 *     loader's own required-config gate is structurally unable to see it.
 *  2. Three `core.web.search` nodes with no `query`, each fed only by a trigger
 *     node. `digest.topic-watch` even declares a `topic` parameter and never
 *     binds it to `search.query`; its upstream emits `{cron,timezone,isCatchUp}`,
 *     and `findFirstStringValue`'s nested pass only reads
 *     `prompt|text|message|content|completion`, so the fallback cannot rescue it
 *     either. All three are dead at node 2 on every fire.
 *
 * ── Why the census models EDGES ─────────────────────────────────────────────
 *
 * A required key can arrive over a port-qualified edge, and a census that reads
 * only `config`/`inputs` calls those nodes starved when they are correctly
 * authored. MEASURED: `campaign-journeys`' three `email-send` nodes bind no `to`
 * and receive one from `recheck.email → welcome.to` (deliberately re-resolved
 * after the approval gate — the gate's own prompt says so). A `to`-side widening
 * without edge modelling would have filed three false starvation reports against
 * correct chains. Edge modelling rescues NOTHING under the current table (0
 * verdicts change), which is the point: it is a false-positive guard installed
 * before it is needed, not a weakening. Stated so it is never mistaken for
 * coverage: `census()`'s USE of the edge term is therefore NOT sabotage-witnessed
 * — deleting it reds nothing today. The helper it composes IS witnessed directly,
 * on the exact campaign-journeys case, by the third probe below.
 *
 * `core.openwop.integration.email-send` is deliberately NOT in the table: it has
 * no early `invalid_config` return at all — it forwards `undefined` to the email
 * adapter — so it fails this table's own membership rule ("read out of the node's
 * own guard"). Its missing-recipient behaviour is a different defect class.
 *
 * The quarantine is SHRINK-ONLY: a new entry fails the test.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHAIN_PACK_ROOT = join(REPO_ROOT, 'examples', 'workflow-chain-packs');

/**
 * A FLOOR, not a schema. Each entry was read out of the node implementation's own
 * early `invalid_config` / `INVALID_INPUTS` return — the guard that actually fires.
 * It is hand-maintained precisely because the nodes that most need it are the ones
 * with no manifest to generate it from; that asymmetry is the residual, not the
 * rule. Adding a node type here can only ever make the gate stricter.
 */
const REQUIRED_BINDINGS: Record<string, string[]> = {
  'core.bigquery.query': ['projectId', 'sql'],
  'core.workday.query': ['baseUrl', 'resource'],
  'core.email.draft': ['to', 'subject'],
  'core.email.send': ['to', 'subject'],
  'knowledge.retrieve': ['query'],
  // ADR 0599 §Correction 5. `core.web.search` returns `invalid_request` with no
  // query — but only AFTER `findFirstStringValue(inputs)`, whose nested pass
  // reads `prompt|text|message|content|completion` and nothing else. A trigger
  // node's `{cron,timezone,isCatchUp}` / `{eventName,payload}` arriving over a
  // portless edge satisfies none of them, so the fallback does not rescue the
  // three chains this row finds.
  'core.web.search': ['query'],
  'feature.documents.nodes.render': ['orgId', 'documentId'],
  'feature.documents.nodes.get-document': ['orgId', 'documentId'],
  'feature.documents.nodes.create-document': ['orgId'],
};

/** Chains this feature owns — excluded from the anti-vacuity floor below, so the
 *  floor cannot be satisfied by the very nodes the table was written around. */
const OWN_CHAIN_PREFIX = 'openwop-app.insights.';

/**
 * SHRINK-ONLY. `<chainId>::<nodeId>` for each starved node this PR did not own.
 * Removing an entry (by fixing the chain) is always allowed; adding one is not.
 */
const QUARANTINE = new Set<string>([
  // ── `core.email.draft` with `config: {}` — one structural cure (ISU-4) ──
  // owner: incident-postmortem
  'postmortem.draft-blameless::save',
  // owner: seo-content-ops
  'seo.keyword-brief::save',
  // owner: support
  'support.email-triage::toDrafts',
  // ── `core.web.search` with no `query`, fed only by a trigger node ──────
  // owner: weekly-digest. Declares a `topic` PARAMETER and never binds it to
  // `search.query`; the only upstream emits `{cron,timezone,isCatchUp}`. Dead at
  // node 2 on every scheduled fire.
  'digest.topic-watch::search',
  // owner: sales-outreach. Upstream `core.trigger.event` → `{eventName,payload}`.
  'outreach.researched-firsttouch::search',
  // owner: seo-content-ops. Same shape (this chain is starved TWICE over).
  'seo.keyword-brief::search',
]);

interface ChainNode { id?: string; typeId?: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> }
interface ChainEdge { to?: unknown }
interface Chain { chainId?: string; dag?: { nodes?: ChainNode[]; edges?: ChainEdge[] } }

/**
 * Keys delivered to each node by a PORT-QUALIFIED edge (`to: "<node>.<key>"`).
 * A portless `to: "<node>"` binds no named key — it hands the whole upstream
 * outputs object to the default input — so it is deliberately not counted.
 */
function edgeBoundKeys(chain: Chain): Map<string, Set<string>> {
  const byNode = new Map<string, Set<string>>();
  for (const edge of chain.dag?.edges ?? []) {
    const to = typeof edge.to === 'string' ? edge.to : '';
    const dot = to.indexOf('.');
    if (dot < 0) continue;
    const nodeId = to.slice(0, dot);
    const key = to.slice(dot + 1);
    if (!byNode.has(nodeId)) byNode.set(nodeId, new Set());
    byNode.get(nodeId)!.add(key);
  }
  return byNode;
}

interface Census {
  scanned: number;
  nodeInstances: number;
  distinctTypeIds: number;
  matched: number;
  matchedForeign: number;
  starved: string[];
}

function census(): Census {
  const starved: string[] = [];
  const typeIds = new Set<string>();
  let scanned = 0;
  let nodeInstances = 0;
  let matched = 0;
  let matchedForeign = 0;
  for (const dir of readdirSync(CHAIN_PACK_ROOT)) {
    let pack: { chains?: Chain[] };
    try {
      pack = JSON.parse(readFileSync(join(CHAIN_PACK_ROOT, dir, 'pack.json'), 'utf8')) as { chains?: Chain[] };
    } catch {
      continue; // not a pack dir
    }
    for (const chain of pack.chains ?? []) {
      scanned++;
      const byEdge = edgeBoundKeys(chain);
      for (const node of chain.dag?.nodes ?? []) {
        nodeInstances++;
        typeIds.add(node.typeId ?? '');
        const required = REQUIRED_BINDINGS[node.typeId ?? ''];
        if (!required) continue;
        matched++;
        if (!(chain.chainId ?? '').startsWith(OWN_CHAIN_PREFIX)) matchedForeign++;
        const bound = new Set([
          ...Object.keys(node.config ?? {}),
          ...Object.keys(node.inputs ?? {}),
          // A key delivered by a port-qualified edge IS bound. Without this the
          // census files false starvation reports against correctly-authored
          // chains (measured: `campaign-journeys`' three `email-send` nodes).
          ...(byEdge.get(node.id ?? '') ?? []),
        ]);
        const missing = required.filter((k) => !bound.has(k));
        if (missing.length > 0) starved.push(`${chain.chainId}::${node.id} (${node.typeId}) missing ${missing.join(',')}`);
      }
    }
  }
  return { scanned, nodeInstances, distinctTypeIds: typeIds.size, matched, matchedForeign, starved };
}

describe('GEN-IS-1 — every chain node binds the config its implementation hard-requires', () => {
  it('has a non-vacuous corpus to check (the failure mode that killed PROBE-DOC-4)', () => {
    const c = census();
    expect(c.scanned, 'no chain packs were scanned — the census is looking at the wrong root').toBeGreaterThan(100);
    // ADR 0599 §Correction 5 — the floor counts FOREIGN matches only. The old
    // `matched > 5` was satisfied at 9, five of which were this feature's own
    // nodes: the table could have covered nothing but itself and still passed.
    expect(
      c.matchedForeign,
      `the required-config table matched ${c.matched} nodes but only ${c.matchedForeign} outside `
      + `'${OWN_CHAIN_PREFIX}*' — the rule has narrowed back onto the feature that wrote it. `
      + `(Corpus: ${c.nodeInstances} chain-node instances across ${c.distinctTypeIds} distinct typeIds `
      + 'in ' + c.scanned + ' chains. This table is a FLOOR, never a coverage claim.)',
    ).toBeGreaterThan(5);
  });

  it('no chain outside the shrink-only quarantine ships a starved required-config node', () => {
    const { starved } = census();
    const unexpected = starved.filter((s) => !QUARANTINE.has(s.slice(0, s.indexOf(' '))));
    expect(unexpected, `starved chain nodes not in the quarantine:\n  ${unexpected.join('\n  ')}`).toEqual([]);
  });

  /**
   * ADR 0599 §Correction 5 — edge modelling, witnessed.
   *
   * Deleting the edge term from `census()` changes **no verdict today**, so the
   * corpus tests above cannot prove it works: it is a false-positive guard
   * installed before it is needed. This is its direct witness, on the exact case
   * that motivated it. `campaign-journeys` binds `to` on its `email-send` nodes
   * ONLY through `recheck.email → welcome.to` (deliberately re-resolved after the
   * approval gate — the gate's prompt says so), so a `to`-side widening without
   * edge modelling would have filed three false starvation reports.
   */
  it('a key delivered by a PORT-QUALIFIED edge counts as bound; a portless edge does not', () => {
    const welcome = {
      chainId: 'probe',
      dag: {
        nodes: [{ id: 'welcome' }, { id: 'plain' }],
        edges: [
          { from: 'recheck.email', to: 'welcome.to' },
          { from: 'trigger', to: 'plain' },
        ],
      },
    };
    const keys = edgeBoundKeys(welcome);
    expect(keys.get('welcome'), 'a port-qualified `to` must bind its named key').toEqual(new Set(['to']));
    expect(keys.get('plain'), 'a portless `to` hands over the whole outputs object and binds NO named key').toBeUndefined();

    // And on the real corpus: the three nodes that would otherwise be false
    // positives are bound, and are bound BY EDGE rather than by config/inputs.
    const pack = JSON.parse(readFileSync(join(CHAIN_PACK_ROOT, 'campaign-journeys', 'pack.json'), 'utf8')) as { chains?: Chain[] };
    const sends: string[] = [];
    for (const chain of pack.chains ?? []) {
      const byEdge = edgeBoundKeys(chain);
      for (const node of chain.dag?.nodes ?? []) {
        if (node.typeId !== 'core.openwop.integration.email-send') continue;
        sends.push(`${chain.chainId}::${node.id}`);
        expect(Object.keys(node.config ?? {}).concat(Object.keys(node.inputs ?? {})), `${node.id} must NOT bind 'to' directly — otherwise this probe proves nothing`).not.toContain('to');
        expect(byEdge.get(node.id ?? '')?.has('to'), `${chain.chainId}::${node.id} receives its recipient by edge`).toBe(true);
      }
    }
    expect(sends.length, 'the campaign-journeys fixture this probe reads has changed shape').toBe(3);
  });

  it('the quarantine is honest — every entry still describes a real starved node', () => {
    const { starved } = census();
    const keys = new Set(starved.map((s) => s.slice(0, s.indexOf(' '))));
    const stale = [...QUARANTINE].filter((q) => !keys.has(q));
    expect(stale, `quarantine entries that are no longer starved (delete them):\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
