/**
 * P2 — chain nodes must supply the config their node type declares REQUIRED.
 *
 * THE DEFECT THIS RATCHETS. `expandChain` refuses an unresolvable *typeId*
 * (RFC 0013 R8 `chain_unresolvable_typeid`) but never checked node CONFIG. So
 * `exec-ops.daily-briefing` shipped a `core.ai.chatCompletion` with
 * `config: {}` — schema-invalid against the pack's own
 * `required: ["provider","model"]` — loaded fine, instantiated fine, and died
 * in production with `provider_not_supported: Provider "undefined"`. The node
 * had destructured two undefined values and passed them to the host verbatim.
 *
 * WHY A CEILING RATHER THAN ZERO. 125 in-tree chain nodes were non-conformant
 * when this landed. Asserting zero would have failed the build on day one and
 * asserting nothing would let the count grow while it is fixed, so this pins
 * the CURRENT number and allows only shrinkage.
 *
 * THE NUMBER MOVED WHEN THE RULE GOT HONEST: 6 → 46. The 6 was the authored
 * form; 46 is what a blank copy actually mints. Lowering it further needs either
 * a defensible default (as the AI nodes got) or the missing-config state
 * surfaced in the builder after the copy — NOT another declared-required param,
 * which is what inflated the old number.
 *
 * P3 fixed the 78 AI nodes (`core.ai.chatCompletion` / `core.ai.structuredOutput`)
 * by giving each chain `provider`/`model` PARAMETERS WITH DEFAULTS and pointing
 * the node config at `{{params.*}}`. The default matters: a whole-value token
 * with no value in the bag resolves to `undefined` (`resolveTokenString`), which
 * would have reproduced the original bug one layer along — parameterizing
 * WITHOUT a default is not a fix.
 *
 * P5 then handled 41 more — `core.trigger.{event,webhook,schedule}`,
 * `email-send.from`, `slack-message.channel` — as REQUIRED chain params with NO
 * default. None of those has a defensible default (a wrong cron runs at the
 * wrong time; a wrong `from` emails from the wrong address), so the honest shape
 * is a declared-required param the author completes in the builder, which is
 * also what the preflight modal already renders.
 *
 * The remaining 6 are `core.trigger.form` (`formSchema`, ×2) and `core.flow.if`
 * (`predicate`, ×4). Both take STRUCTURED, chain-specific values; authoring them
 * blind would be inventing product behaviour, so they stay counted rather than
 * quietly parameterized. 125 → 6.
 *
 * KEY-PRESENCE, not value validation — see `findMissingRequiredConfig`. A chain
 * legitimately authors `"provider": "{{params.provider}}"`; the value arrives
 * when expansion freezes params in.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMissingRequiredConfig, expandChain, findUnfilledExpansionParams, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';

const REPO = join(import.meta.dirname, '../../..');
const CHAIN_ROOT = join(REPO, 'examples/workflow-chain-packs');
const NODE_PACK_ROOT = join(REPO, 'packs');

/**
 * NO-GROWTH ceiling. Lower it as P3 lands; NEVER raise it. Raising it means a
 * new chain shipped a node that cannot run — the exact production failure this
 * file exists to prevent.
 */
const MISSING_CONFIG_CEILING = 42;

/** typeId → required config keys, read from each node pack's configSchema. */
function requiredConfigKeyMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!existsSync(NODE_PACK_ROOT)) return map;
  for (const dir of readdirSync(NODE_PACK_ROOT)) {
    const manifestPath = join(NODE_PACK_ROOT, dir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: { nodes?: Array<{ typeId?: string; configSchemaRef?: string }>; nodeTypes?: Array<{ typeId?: string; configSchemaRef?: string }> };
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest; } catch { continue; }
    for (const n of manifest.nodes ?? manifest.nodeTypes ?? []) {
      if (!n.typeId || !n.configSchemaRef) continue;
      const schemaPath = join(NODE_PACK_ROOT, dir, n.configSchemaRef);
      if (!existsSync(schemaPath)) continue;
      try {
        const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { required?: string[] };
        if (Array.isArray(schema.required) && schema.required.length > 0) map.set(n.typeId, schema.required);
      } catch { /* an unparseable schema is its own problem, not this gate's */ }
    }
  }
  return map;
}

function allChains(): WorkflowChain[] {
  const out: WorkflowChain[] = [];
  if (!existsSync(CHAIN_ROOT)) return out;
  for (const dir of readdirSync(CHAIN_ROOT)) {
    const p = join(CHAIN_ROOT, dir, 'pack.json');
    if (!existsSync(p)) continue;
    try {
      const pack = JSON.parse(readFileSync(p, 'utf8')) as { chains?: WorkflowChain[] };
      for (const c of pack.chains ?? []) out.push(c);
    } catch { /* malformed pack — the loader's own tests cover that */ }
  }
  return out;
}

const requiredMap = requiredConfigKeyMap();
const requiredFor = (typeId: string): readonly string[] => requiredMap.get(typeId) ?? [];
const chains = allChains();
/**
 * §Correction (grade-code HIGH-1 / grade-data GATE-1) — measure the EXPANDED
 * definition of a BLANK copy, not the authored chain.
 *
 * The authored form counted a `{{params.X}}` token as present whenever X was
 * declared required. But enforcement was reverted (ADR 0497 D5) and
 * `seedWorkflows` expands with `{}`, so that token resolves to `undefined` and
 * expansion DROPS the key — the minted node ships `config: {}`, the original
 * incident shape. Two graders measured this independently: the old rule read
 * 125→6 while actual undefined-frozen keys went 63→98. A gate that improves
 * while the thing it gates gets worse is not a gate.
 *
 * `params: {}` is deliberate: it is the documented "just copy" path, so this
 * measures the worst case a user can actually reach.
 */
const findings = chains.flatMap((c) => {
  try {
    return findMissingRequiredConfig(expandChain(c, { params: {} }).nodes, requiredFor, c.chainId);
  } catch {
    return []; // a chain that cannot expand is the loader's own tests' problem
  }
});

describe('chain node config conformance', () => {
  it('the scan is NON-VACUOUS (a broken reader would report zero and pass)', () => {
    expect(chains.length, 'no chains read — the walker is broken, not the content').toBeGreaterThan(20);
    expect(requiredMap.size, 'no node type declared required config — schemas unreadable').toBeGreaterThan(10);
    // The known-good control: this node type genuinely requires provider+model.
    expect(requiredFor('core.ai.chatCompletion')).toEqual(expect.arrayContaining(['provider', 'model']));
  });

  it('missing-required-config count only SHRINKS', () => {
    expect(
      findings.length,
      `${findings.length} chain nodes omit required config (ceiling ${MISSING_CONFIG_CEILING}). `
      + 'A node missing required config CANNOT RUN — it fails at dispatch, not at authoring. '
      + 'Supply the key (a `{{params.*}}` token counts), or lower the ceiling if you fixed some.',
    ).toBeLessThanOrEqual(MISSING_CONFIG_CEILING);
  });

  it('the ceiling is not stale — lower it when the count drops', () => {
    // Keeps the ceiling honest: a fix that forgets to lower it leaves a silent
    // allowance for the NEXT bad node, which is how ratchets rot.
    expect(
      MISSING_CONFIG_CEILING - findings.length,
      `The ceiling is ${MISSING_CONFIG_CEILING} but only ${findings.length} nodes are non-conformant. `
      + `Lower MISSING_CONFIG_CEILING to ${findings.length}.`,
    ).toBeLessThanOrEqual(0);
  });

  it('the fixed reference chain stays conformant (P3 regression guard)', () => {
    // `production-plan` already parameterizes provider/model — the pattern P3
    // applies everywhere else. If this ever regresses, the pattern itself broke.
    const ref = chains.find((c) => c.chainId === 'openwop-app.production.plan');
    expect(ref, 'reference chain not found — rename? update this guard').toBeDefined();
    expect(findMissingRequiredConfig(expandChain(ref!, { params: {} }).nodes, requiredFor, ref!.chainId)).toEqual([]);
  });
});

/**
 * REACHABILITY. The runtime half of P2 is a `requiredConfigKeysFor` callback
 * that `expandChain` only invokes when a caller supplies it — so a wired-looking
 * option with no caller would be dead code, which is this codebase's recurring
 * defect class. `/workflows/from-chain` passes the catalog-backed accessor;
 * these assert the accessor itself is real rather than an empty stub.
 *
 * ENVIRONMENT-DEPENDENT BY CONSTRUCTION: the accessor reads the INSTALLED pack
 * dir (`~/.openwop-packs`), which is empty in a fresh clone, so the assertion is
 * conditional. That is a real limit of this test, not something it hides — the
 * repo-relative scan above is the gate that always runs.
 */
describe('P2 runtime reachability', () => {
  it('the catalog-backed accessor returns real required keys when packs are installed', async () => {
    const { requiredConfigKeysFor, requiredConfigKeyMap } = await import('../src/host/nodeCatalogBuilder.js');
    const map = requiredConfigKeyMap();
    if (map.size === 0) {
      // No installed packs in this environment — nothing to assert against.
      expect(requiredConfigKeysFor('core.ai.chatCompletion')).toEqual([]);
      return;
    }
    // Installed: the accessor must agree with the repo scan for a known type.
    const fromCatalog = requiredConfigKeysFor('core.ai.chatCompletion');
    if (fromCatalog.length > 0) {
      expect(fromCatalog).toEqual(expect.arrayContaining(['provider', 'model']));
    }
  });

  it('the accessor is memoized (a per-expansion FS scan would be a hot-path cost)', async () => {
    const { requiredConfigKeyMap } = await import('../src/host/nodeCatalogBuilder.js');
    expect(requiredConfigKeyMap()).toBe(requiredConfigKeyMap()); // same object ⇒ cached
  });
});

/**
 * SSoT DRIFT (code-review MEDIUM #5). P3 wrote `anthropic` / `claude-sonnet-4-6`
 * as parameter defaults into 73 chains. The VALUE is right — it is
 * `providers.json`'s own `recommended` entry, not a guess — but it is now
 * duplicated 73 times away from the catalog that owns it, and
 * `/refresh-model-catalog` updates the catalog, not the packs. Without this
 * check, deprecating that model would leave every shipped chain pinning a dead
 * one, silently.
 *
 * `packs/feature.production.nodes/index.mjs` already carries the same debt with
 * the same mitigation (a greppable constant the sweep updates, labelled DEBT-3),
 * so this follows an established in-tree convention rather than inventing one.
 */
describe('chain provider/model defaults track providers.json', () => {
  const catalogPath = join(REPO, 'providers.json');

  it('every provider/model default a chain declares exists in the catalog', () => {
    if (!existsSync(catalogPath)) return; // catalog vendored elsewhere in this env
    const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown;
    const provs = (Array.isArray(raw) ? raw : (raw as { providers?: unknown[] }).providers ?? []) as Array<{ id?: string; models?: Array<{ id?: string }> }>;
    const models = new Map(provs.map((p) => [p.id, new Set((p.models ?? []).map((m) => m.id))]));

    const bad: string[] = [];
    for (const c of chains) {
      const props = ((c.parameters as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties) ?? {};
      const prov = props.provider?.default;
      const model = props.model?.default;
      if (typeof prov !== 'string') continue;
      if (!models.has(prov)) { bad.push(`${c.chainId}: provider "${prov}" not in providers.json`); continue; }
      if (typeof model === 'string' && !models.get(prov)!.has(model)) {
        bad.push(`${c.chainId}: model "${model}" not advertised by "${prov}"`);
      }
    }
    expect(
      bad,
      'A chain pins a provider/model the catalog no longer advertises. Re-run the model sweep '
      + 'over examples/workflow-chain-packs/, or the shipped gallery dispatches to a dead model.',
    ).toEqual([]);
  });

  it('the check is non-vacuous (some chain actually declares a default)', () => {
    const withDefault = chains.filter((c) =>
      typeof ((c.parameters as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties?.provider?.default) === 'string');
    expect(withDefault.length).toBeGreaterThan(50);
  });
});

/**
 * VALUE-level checks the key-presence rule cannot see (grade-data PACK-1/PACK-2).
 *
 * Both defects below shipped in this program and neither existing gate saw them:
 * a param default that violates its own node's `configSchema` pattern (5 webhook
 * paths missing the required leading `/`), and THREE duplicate `"default"` keys
 * in one object — which `JSON.parse` silently resolves last-wins, so the shipped
 * value was correct by luck rather than construction.
 */
describe('pack VALUES, not just keys', () => {
  it('no pack JSON contains a duplicate key (JSON.parse hides these)', () => {
    const dupes: string[] = [];
    for (const dir of readdirSync(CHAIN_ROOT)) {
      const p = join(CHAIN_ROOT, dir, 'pack.json');
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf8');
      // Scan the RAW text: `JSON.parse` resolves a duplicate key last-wins and
      // reports nothing, which is exactly how three `"default"` keys shipped.
      // Flat-object scan — the shape that actually bit us.
      for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
        const keys = [...m[0].matchAll(/"([^"]+)"\s*:/g)].map((x) => x[1]!);
        const seen = new Set<string>();
        for (const k of keys) {
          if (seen.has(k)) { dupes.push(`${dir}: duplicate "${k}"`); break; }
          seen.add(k);
        }
      }
    }
    expect(dupes, 'A duplicate key parses last-wins — the shipped value is luck, not intent.').toEqual([]);
  });

  it('every param default satisfies its consuming node\'s configSchema pattern', () => {
    // Read the full property spec (not just `required`) for pattern checking.
    const specFor = new Map<string, Record<string, { pattern?: string }>>();
    for (const dir of readdirSync(NODE_PACK_ROOT)) {
      const mp = join(NODE_PACK_ROOT, dir, 'pack.json');
      if (!existsSync(mp)) continue;
      let manifest: { nodes?: Array<{ typeId?: string; configSchemaRef?: string }>; nodeTypes?: Array<{ typeId?: string; configSchemaRef?: string }> };
      try { manifest = JSON.parse(readFileSync(mp, 'utf8')) as typeof manifest; } catch { continue; }
      for (const n of manifest.nodes ?? manifest.nodeTypes ?? []) {
        if (!n.typeId || !n.configSchemaRef) continue;
        const sp = join(NODE_PACK_ROOT, dir, n.configSchemaRef);
        if (!existsSync(sp)) continue;
        try {
          const schema = JSON.parse(readFileSync(sp, 'utf8')) as { properties?: Record<string, { pattern?: string }> };
          if (schema.properties) specFor.set(n.typeId, schema.properties);
        } catch { /* unparseable schema is its own problem */ }
      }
    }
    expect(specFor.size, 'no node schemas read — the walker is broken').toBeGreaterThan(10);

    const bad: string[] = [];
    for (const c of chains) {
      const props = ((c.parameters as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties) ?? {};
      for (const n of c.dag.nodes) {
        const nodeProps = specFor.get(n.typeId);
        if (!nodeProps) continue;
        for (const [key, val] of Object.entries((n.config ?? {}) as Record<string, unknown>)) {
          const pattern = nodeProps[key]?.pattern;
          if (!pattern || typeof val !== 'string') continue;
          const m = /^\s*\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}\s*$/.exec(val);
          const effective = m ? props[m[1]!]?.default : val;
          if (typeof effective !== 'string') continue; // no default ⇒ nothing to check
          if (!new RegExp(pattern).test(effective)) {
            bad.push(`${c.chainId}/${n.id}.${key} = ${JSON.stringify(effective)} violates ${pattern}`);
          }
        }
      }
    }
    expect(bad, 'A default that violates its node\'s own schema fails at dispatch, not at authoring.').toEqual([]);
  });
});

/**
 * BRANCH NODES MUST ACTUALLY BRANCH (grade-code HIGH-3 / grade-data).
 *
 * Four shipped chains had `core.flow.if` with `config: {}`. That is not a soft
 * failure — `packs/core.openwop.flow/index.mjs` does
 * `runPredicate(ctx.config.predicate, …)` → `resolvePath(item, predicate.path)`,
 * so it throws a raw `TypeError` at dispatch. Two of the four are auto-seeded to
 * every tenant.
 *
 * The second half is subtler and the key-presence rule is blind to it: their
 * out-edges carried no `condition`, so even WITH a predicate both branches fire
 * and the "routing" decides nothing. `inbox.triage` is the in-repo precedent for
 * the correct shape (`branch` equals `then` / `else`).
 */
describe('core.flow.if nodes branch for real', () => {
  const ifNodesOf = (c: WorkflowChain) => c.dag.nodes.filter((n) => n.typeId === 'core.flow.if');

  it('is non-vacuous — the shipped packs really do contain branch nodes', () => {
    expect(chains.flatMap(ifNodesOf).length).toBeGreaterThan(3);
  });

  it('every core.flow.if declares a predicate (absence throws a TypeError at dispatch)', () => {
    const bare: string[] = [];
    for (const c of chains) {
      for (const n of ifNodesOf(c)) {
        if (!((n.config ?? {}) as Record<string, unknown>).predicate) bare.push(`${c.chainId}/${n.id}`);
      }
    }
    expect(bare, 'core.flow.if with no predicate throws `Cannot read properties of undefined`.').toEqual([]);
  });

  it('every out-edge of a branch node carries a condition (else both branches fire)', () => {
    const unconditioned: string[] = [];
    for (const c of chains) {
      const ids = new Set(ifNodesOf(c).map((n) => n.id));
      for (const e of (c.dag.edges ?? []) as Array<{ from?: string; to?: string; condition?: unknown }>) {
        if (!e.from || !ids.has(e.from.split('.')[0]!)) continue;
        if (!e.condition) unconditioned.push(`${c.chainId}: ${e.from} → ${e.to}`);
      }
    }
    expect(
      unconditioned,
      'An unconditioned edge out of core.flow.if fires regardless of the branch — the routing decides nothing.',
    ).toEqual([]);
  });
});

/**
 * THE SAME DEFECT ONE FIELD OVER — required INPUTS (grade-code HIGH-5.1).
 *
 * Everything above measures node `config`. `inputSchemaRef` was never scanned at
 * all, and that is where the largest remaining instance lives:
 * `email-send.input.json` declares `required: ["to","subject"]`, the pack does
 * `const { to, subject } = ctx.inputs`, and 13 shipped nodes never bind them —
 * 10 carry `inputs: {}` with in-edges landing on the DEFAULT port rather than
 * `.to`/`.subject`. The node still returns `status:'success'` with `sent:false`,
 * so a run whose only outbound action failed completes green.
 *
 * THE RULE IS DELIBERATELY NARROW. A first attempt counted every unbound
 * required input and reported 264 — wrong, because a single in-edge with no port
 * suffix legitimately feeds a node's PRIMARY input. So this counts only nodes
 * missing TWO OR MORE required inputs, where one default-port edge cannot
 * possibly satisfy both. That is 72 nodes, and it surfaces a larger instance than
 * the one reported: `notification-push` ×55, ahead of `email-send` ×10.
 *
 * NOT AUTHORED HERE, deliberately. A predicate is derivable from the chain's own
 * prompt contract (see the branch-node block above); a recipient address is not —
 * binding the wrong upstream port means emailing the wrong person, which is worse
 * than not sending. This pins the count so it cannot grow while the bindings are
 * authored per chain with their upstream outputs in hand.
 *
 * 62 -> 7 (2026-08-02): `notification-push` x55 retargeted onto
 * `feature.notifications.nodes.notify`, the host-owned in-app node over the ONE
 * emitter. That node takes NO recipient input — the audience is authoring-time
 * config — so the 55 stop being unbindable. This was the dominant item on the
 * list and the ADR called it a CONTRACT defect, not content debt; it was.
 *
 * 72 -> 62 (2026-07-30): the `email-send` x10 are authored, per chain, with their
 * upstream outputs in hand (ADR 0498 Correction record 3). `to`/`subject` come
 * from declared params where no upstream node produces a recipient, and the body
 * from the drafting node's `content` port. The remaining 62 are dominated by
 * `notification-push` x55, which is a CONTRACT defect — see the ADR: it wants a
 * host-owned in-app notification node, not per-chain bindings.
 */
const REQUIRED_INPUT_CEILING = 7;

describe('required INPUTS conformance (the unratcheted half)', () => {
  const requiredInputsFor = (() => {
    const map = new Map<string, string[]>();
    for (const dir of readdirSync(NODE_PACK_ROOT)) {
      const mp = join(NODE_PACK_ROOT, dir, 'pack.json');
      if (!existsSync(mp)) continue;
      let manifest: { nodes?: Array<{ typeId?: string; inputSchemaRef?: string }>; nodeTypes?: Array<{ typeId?: string; inputSchemaRef?: string }> };
      try { manifest = JSON.parse(readFileSync(mp, 'utf8')) as typeof manifest; } catch { continue; }
      for (const n of manifest.nodes ?? manifest.nodeTypes ?? []) {
        if (!n.typeId || !n.inputSchemaRef) continue;
        const sp = join(NODE_PACK_ROOT, dir, n.inputSchemaRef);
        if (!existsSync(sp)) continue;
        try {
          const schema = JSON.parse(readFileSync(sp, 'utf8')) as { required?: string[] };
          if (Array.isArray(schema.required) && schema.required.length) map.set(n.typeId, schema.required);
        } catch { /* unparseable schema is its own problem */ }
      }
    }
    return map;
  })();

  /** A required input is satisfied by an explicit `inputs` entry OR an in-edge
   *  landing on that named port (`<node>.<port>`). Only nodes missing 2+ count —
   *  see the narrowing note above. */
  const unboundInputs = (c: WorkflowChain): string[] => {
    const out: string[] = [];
    for (const n of c.dag.nodes) {
      const required = requiredInputsFor.get(n.typeId);
      if (!required || required.length < 2) continue;
      const declared = new Set(Object.keys((n.inputs ?? {}) as Record<string, unknown>));
      const viaEdge = new Set(
        ((c.dag.edges ?? []) as Array<{ to?: string }>)
          .map((e) => e.to ?? '')
          .filter((t) => t.split('.')[0] === n.id && t.includes('.'))
          .map((t) => t.slice(t.indexOf('.') + 1)),
      );
      const missing = required.filter((k) => !declared.has(k) && !viaEdge.has(k));
      if (missing.length >= 2) out.push(`${c.chainId}/${n.id} [${missing.join(', ')}]`);
    }
    return out;
  };

  it('is non-vacuous — some node type really does declare required inputs', () => {
    expect(requiredInputsFor.size).toBeGreaterThan(0);
    expect(requiredInputsFor.get('core.openwop.integration.email-send')).toEqual(
      expect.arrayContaining(['to', 'subject']),
    );
  });

  it('unbound required-input count only SHRINKS', () => {
    const unbound = chains.flatMap(unboundInputs);
    expect(
      unbound.length,
      `${unbound.length} required node INPUTS are never bound (ceiling ${REQUIRED_INPUT_CEILING}). `
      + 'The node reads them off ctx.inputs and silently reports success — bind the port '
      + '(an in-edge `<node>.<port>` counts) or lower the ceiling if you fixed some.',
    ).toBeLessThanOrEqual(REQUIRED_INPUT_CEILING);
  });

  /**
   * GRD-5 — the rule above is BLIND to the defect it looks like it covers, twice
   * over, and both blind spots were found by measuring rather than reading.
   *
   * 1. It reads the AUTHORED `node.inputs`. Path A expansion freezes
   *    `{{params.X}}`, so what SHIPS is not what was authored.
   * 2. It tests KEY PRESENCE. After a blank expansion the key is still there —
   *    holding `undefined`. (`hasOwnProperty('to') === true`,
   *    `typeof inputs.to === 'undefined'`.) `JSON.stringify` omits
   *    undefined-valued keys, which is why an early probe read this as "the key
   *    is dropped" and why the first version of the ADR 0498 caveat says so. It
   *    is not dropped; it is present and undefined — the `Provider "undefined"`
   *    shape exactly, and strictly worse than absent, because a key-presence
   *    check reports it as BOUND.
   *
   * So this rule evaluates the EXPANDED blank copy and checks VALUES.
   *
   * It also does NOT count a required input that is undefined merely because the
   * user has not filled a declared param yet — that is the honest
   * needs-configuration state of a copied template, surfaced by name via ADR
   * 0504 `findUnfilledExpansionParams`. What it counts is UNFILLABLE: no edge
   * binds it, no literal supplies it, and no declared param maps to it, so no
   * amount of filling in the form will ever make the node runnable.
   *
   * Ceiling 43, and that number was itself corrected twice while writing this —
   * both times by a probe, not by reading:
   *   - node-level attribution exempted every undefined input on a node that had
   *     ANY unfilled param, reading 38;
   *   - the first port-level fix keyed on `inputs.<port>` when
   *     `UnfilledParamFinding.key` is the BARE name, so the exemption matched
   *     nothing and read 59.
   * 43 is the count with attribution actually working.
   *
   * `email-send` is 0 here — #2700 made those genuinely fillable via
   * `recipientEmail`, and this rule PROVES that rather than assuming it. The
   * residue is dominated by `core.ai.chatCompletion.messages`, which is very
   * likely an OVER-DECLARED input schema (the node composes messages from its
   * config prompts) rather than that many broken chains — the same shape as the
   * `notification-push` x55 contract defect in ADR 0498 §Open. Confirm against
   * the node pack before authoring bindings for them.
   */
  const UNFILLABLE_INPUT_CEILING = 5;

  const unfillableInputs = (c: WorkflowChain): string[] => {
    let def: ReturnType<typeof expandChain>;
    try {
      def = expandChain(c, { params: {} });
    } catch {
      return []; // a chain that cannot expand at all is the other ratchet's problem
    }
    // PORT-level, not node-level. Attributing per NODE exempted every undefined
    // input on a node that had ANY unfilled param — a probe that deleted `to`
    // outright left the count unmoved, which is how that was caught. `key` is the BARE
    // port/config name the param would have filled (`to`, `from`) — verified, not
    // assumed; an earlier `inputs.${k}` guess matched nothing and silently turned
    // the exemption into a dead branch that inflated the count from 38 to 59.
    const attributable = new Set(
      findUnfilledExpansionParams(def).map((u) => `${u.nodeId}::${u.key}`),
    );
    const out: string[] = [];
    for (const n of def.nodes) {
      const required = requiredInputsFor.get(n.typeId);
      if (!required) continue;
      const inputs = ((n as { inputs?: Record<string, unknown> }).inputs ?? {});
      const inbound = (def.edges ?? []).filter((e) => e.targetNodeId === n.nodeId);
      // The executor unwraps ONLY a lone default-port inbound, and then ctx.inputs
      // IS the upstream outputs map — which may legitimately carry these keys.
      if (inbound.length === 1 && !inbound[0].targetInput) continue;
      const namedPorts = new Set(inbound.map((e) => e.targetInput).filter(Boolean));
      const undefinedRequired = required.filter((k) => inputs[k] === undefined && !namedPorts.has(k));
      // Attributable to a declared param ⇒ the form can fill it ⇒ not a defect.
      const unfillable = undefinedRequired.filter((k) => !attributable.has(`${n.nodeId}::${k}`));
      if (unfillable.length) out.push(`${c.chainId}/${n.nodeId} [${unfillable.join(', ')}]`);
    }
    return out;
  };

  it('is non-vacuous — the expanded form really is inspected', () => {
    const sample = chains.find((c) => c.chainId === 'inbox.followup-nudger');
    expect(sample, 'the sample chain must exist or this rule proves nothing').toBeTruthy();
    const def = expandChain(sample!, { params: {} });
    const send = def.nodes.find((n) => n.typeId === 'core.openwop.integration.email-send');
    const inputs = ((send as unknown as { inputs?: Record<string, unknown> })?.inputs ?? {});
    // The exact shape this rule exists for: present, and undefined.
    expect(Object.prototype.hasOwnProperty.call(inputs, 'to')).toBe(true);
    expect(inputs.to).toBeUndefined();
  });

  it('no required input is UNFILLABLE (no edge, no literal, no param)', () => {
    const unfillable = chains.flatMap(unfillableInputs);
    expect(
      unfillable.length,
      `${unfillable.length} required inputs can never be filled (ceiling ${UNFILLABLE_INPUT_CEILING}). `
      + 'Unlike the ceiling above this is measured on the EXPANDED blank copy and on VALUES, '
      + 'so it sees a key that survives expansion holding `undefined`.',
    ).toBeLessThanOrEqual(UNFILLABLE_INPUT_CEILING);
  });

  it('the unfillable ceiling is not stale', () => {
    const unfillable = chains.flatMap(unfillableInputs);
    expect(
      UNFILLABLE_INPUT_CEILING - unfillable.length,
      `Ceiling ${UNFILLABLE_INPUT_CEILING} but only ${unfillable.length} unfillable — lower it to ${unfillable.length}.`,
    ).toBeLessThanOrEqual(0);
  });

  it('the input ceiling is not stale', () => {
    const unbound = chains.flatMap(unboundInputs);
    expect(
      REQUIRED_INPUT_CEILING - unbound.length,
      `Ceiling ${REQUIRED_INPUT_CEILING} but only ${unbound.length} unbound — lower it to ${unbound.length}.`,
    ).toBeLessThanOrEqual(0);
  });

  /**
   * `unboundInputs` above counts a port as BOUND whenever `n.inputs` has the key,
   * whatever the value is. So `"to": "{{params.recipientEmail}}"` and
   * `"to": "{{params.recipientEmial}}"` are indistinguishable to it — and the
   * second freezes to `undefined` at expansion, which is the original
   * `Provider "undefined"` defect one layer along ("parameterizing without a
   * value is not a fix", §Decision). The same blind spot exists in
   * `chain-email-envelope-wiring.test.ts`, which is why this lives here, over
   * EVERY node, rather than in the email-specific ratchet.
   *
   * Zero tolerance, not a ceiling: a token naming a parameter the chain does not
   * declare is never intentional.
   */
  it('every {{params.X}} token names a parameter the chain actually declares', () => {
    const PARAM_TOKEN = /\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}/g;
    const dangling: string[] = [];
    for (const c of chains) {
      const declared = new Set(Object.keys(
        ((c.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {},
      ));
      for (const n of c.dag.nodes) {
        for (const slot of ['config', 'inputs'] as const) {
          const bag = (n as unknown as Record<string, unknown>)[slot];
          if (!bag) continue;
          for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
            for (const m of JSON.stringify(value).matchAll(PARAM_TOKEN)) {
              if (!declared.has(m[1])) dangling.push(`${c.chainId}/${n.id}.${slot}.${key} -> {{params.${m[1]}}}`);
            }
          }
        }
      }
    }
    expect(dangling, 'these tokens resolve to `undefined` at expansion — declare the param or fix the name').toEqual([]);
  });

  it('the dangling-token scan is non-vacuous — it really reads tokens and declarations', () => {
    const PARAM_TOKEN = /\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}/g;
    let tokens = 0;
    let withDeclarations = 0;
    for (const c of chains) {
      if (Object.keys(((c.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}).length) withDeclarations += 1;
      for (const n of c.dag.nodes) {
        for (const slot of ['config', 'inputs'] as const) {
          const bag = (n as unknown as Record<string, unknown>)[slot];
          if (bag) tokens += [...JSON.stringify(bag).matchAll(PARAM_TOKEN)].length;
        }
      }
    }
    expect(tokens, 'no param tokens found at all — the scan is looking at the wrong place').toBeGreaterThan(50);
    expect(withDeclarations, 'no chain declares parameters — the `declared` set is always empty').toBeGreaterThan(10);
  });
});

/**
 * THE ADR MUST QUOTE THE LIVE NUMBERS.
 *
 * ADR 0498's §Open went stale within a day of being written: it still listed the
 * `core.flow.if` predicates, the seed lane and "inputs are unratcheted" as open
 * after #2671 had closed all three, and it quoted a ceiling of 6 that #2661 had
 * already corrected to 46. A decision record that misreports what is still broken
 * is worse than none — the next reader plans against it.
 *
 * The ratchets above are the source of truth; this asserts the prose agrees with
 * them. Cheap, and it fails the moment a ceiling moves without the ADR following.
 */
describe('ADR 0498 §Open quotes the live ceilings', () => {
  const adr = join(REPO, 'docs/adr/0498-chain-node-config-conformance.md');

  it('the ADR exists and names both ratchets', () => {
    expect(existsSync(adr), 'ADR renamed or renumbered — update this guard').toBe(true);
    const text = readFileSync(adr, 'utf8');
    expect(text).toMatch(/ceiling 42|ceiling \*\*42\*\*/i);
    expect(text).toMatch(/ceiling 72|ceiling \*\*72\*\*/i);
  });

  it('the ADR does not still describe CLOSED work as open', () => {
    // The staleness that motivated this guard was not a wrong number — it was
    // prose asserting three fixed things were broken. A bare "does 42 appear
    // anywhere" check passes on a stale ADR (42 occurs elsewhere in the text),
    // which is why that version of this test was replaced: it gave confidence
    // without evidence.
    const text = readFileSync(adr, 'utf8');
    const closed: Array<[RegExp, string]> = [
      [/entirely unratcheted/i, 'inputs ARE ratcheted since #2671'],
      [/core\.flow\.if.*hard-throw/is, 'the four predicates were authored in #2671'],
      [/`getRegisteredWorkflowAsync` instead of the sync cache/i, 'the seed lane was fixed in #2671'],
    ];
    const stale = closed.filter(([re]) => re.test(text)).map(([, why]) => why);
    expect(stale, 'ADR 0498 §Open still lists work that has landed.').toEqual([]);
  });
});

/**
 * `feature.kb.nodes.rag` READS `ctx.inputs`, NEVER `ctx.config`.
 *
 * Four shipped chains wired the query through `config` — which the node's
 * implementation (`packs/feature.kb.nodes/index.mjs` → `inputs(ctx)`) never
 * reads — so every real invocation reached `mustGetCollection(tenantId, '', '')`
 * and threw `not_found`. The KB step could not complete as shipped.
 *
 * ONE of the four had a test, and it ASSERTED the `not_found` as "the honest,
 * reproducible current behavior". That pin is why the other three were never
 * swept for: a documented failure reads like a handled one.
 *
 * The generic input ratchet above cannot see this — `rag`'s input schema does
 * not mark these `required`, so nothing flagged them. This is node-specific by
 * necessity, and it is exactly the shape worth ratcheting: an implementation
 * that reads one bag while the content writes the other.
 */
describe('feature.kb.nodes.rag binds its inputs, not its config', () => {
  const RAG = 'feature.kb.nodes.rag';
  const NEEDED = ['orgId', 'collectionId', 'query'] as const;

  const ragNodes = chains.flatMap((c) =>
    c.dag.nodes.filter((n) => n.typeId === RAG).map((n) => ({ chain: c, node: n })));

  it('is non-vacuous — the shipped packs really do use this node', () => {
    expect(ragNodes.length, 'no rag nodes found — renamed? update this guard').toBeGreaterThanOrEqual(4);
  });

  it('every rag node supplies orgId/collectionId/query via inputs (or an in-edge on that port)', () => {
    const bad: string[] = [];
    for (const { chain, node } of ragNodes) {
      const declared = new Set(Object.keys((node.inputs ?? {}) as Record<string, unknown>));
      const viaEdge = new Set(
        ((chain.dag.edges ?? []) as Array<{ to?: string }>)
          .map((e) => e.to ?? '')
          .filter((t) => t.split('.')[0] === node.id && t.includes('.'))
          .map((t) => t.slice(t.indexOf('.') + 1)),
      );
      const missing = NEEDED.filter((k) => !declared.has(k) && !viaEdge.has(k));
      if (missing.length) bad.push(`${chain.chainId}/${node.id} [${missing.join(', ')}]`);
    }
    expect(
      bad,
      'These rag nodes resolve to empty strings at dispatch and throw `not_found`. '
      + 'Bind them on the node\'s `inputs` — `config` is never read by this node.',
    ).toEqual([]);
  });

  it('a rag node bound to a param means that param is declared', () => {
    // A `{{params.x}}` pointing at a param the chain never declares resolves to
    // undefined, which is the same empty-string failure one step removed.
    const dangling: string[] = [];
    for (const { chain, node } of ragNodes) {
      const props = ((chain.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
      for (const [port, v] of Object.entries((node.inputs ?? {}) as Record<string, unknown>)) {
        const m = typeof v === 'string' ? /^\s*\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}\s*$/.exec(v) : null;
        if (m && !(m[1]! in props)) dangling.push(`${chain.chainId}/${node.id}.${port} → params.${m[1]}`);
      }
    }
    expect(dangling, 'binds a param the chain does not declare.').toEqual([]);
  });
});
