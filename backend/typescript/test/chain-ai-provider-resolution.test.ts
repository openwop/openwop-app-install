/**
 * P3 — the reported production failure, end to end.
 *
 * A run of `wf.exec-ops-daily-briefing` failed with
 * `provider_not_supported: Provider "undefined" is not in the host's
 * aiProviders.supported list`. The chain's `brief` node
 * (`core.ai.chatCompletion`) shipped `config: {}` while the node type's schema
 * declares `required: ["provider","model"]`, so the pack node destructured two
 * undefined values and handed them to the host verbatim.
 *
 * This asserts on the EXPANDED DEFINITION rather than on a ratchet count,
 * because the count moving is not evidence the workflow runs. What the run
 * needs is a concrete provider frozen into the node config at expansion — and
 * frozen is what keeps replay deterministic (`providerKey` in aiProvidersHost
 * hashes provider+model into the Layer-2 invocation-log cache key, so resolving
 * per-dispatch instead would have made a catalog change silently re-dispatch on
 * replay).
 *
 * CORRECTED (ADR 0903 D7, user decision 2026-10-17): chains no longer DEFAULT a
 * vendor. The incident is now prevented at CALL time: a node with no provider/
 * model takes the run's AI default (`withRunAiDefault`), which is frozen into
 * `run.metadata.aiDefault` at run start, so replay stays deterministic (the
 * cache key hashes the RESOLVED provider+model). What must never reach a call is
 * an unresolved token, an empty string or the literal "undefined"; an ABSENT key
 * is fine, because the host fills it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { withRunAiDefault } from '../src/host/runAiDefault.js';

/** A run's frozen AI default, as `runAiDefaultContributor` stamps it. */
const RUN_DEFAULT = { provider: 'google', model: 'gemini-test', source: 'catalog' as const };
/** What a call from this node config actually dispatches with (ADR 0903 D3). */
const dispatched = (cfg: Record<string, unknown>) =>
  withRunAiDefault({ provider: cfg.provider as string | undefined, model: cfg.model as string | undefined }, RUN_DEFAULT);
/** Absent is allowed (the host fills it); a token, '' or "undefined" is the incident. */
const badValue = (v: unknown) => v !== undefined && (typeof v !== 'string' || v === '' || /\{\{|undefined/.test(v));

const PACK_ROOT = join(import.meta.dirname, '../../../examples/workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [PACK_ROOT] });
});

const chainById = (id: string) => {
  const found = listChains().find((c) => c.chain.chainId === id);
  expect(found, `chain ${id} not loaded — rename?`).toBeDefined();
  return found!.chain;
};

describe('the reported failure: exec-ops.daily-briefing', () => {
  it('expands with no vendor pinned, and a call from it dispatches with a CONCRETE provider + model', () => {
    // `orgId` is a genuinely required param with no default — supply it, as the
    // instantiating caller does.
    const def = expandChain(chainById('exec-ops.daily-briefing'), { params: { orgId: 'org-1' } });
    const ai = def.nodes.filter((n) => n.typeId === 'core.ai.chatCompletion');
    expect(ai.length, 'fixture guard: no AI node in this chain').toBeGreaterThan(0);
    for (const n of ai) {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      expect(badValue(cfg.provider), `${n.nodeId}.provider = ${JSON.stringify(cfg.provider)}`).toBe(false);
      expect(badValue(cfg.model), `${n.nodeId}.model = ${JSON.stringify(cfg.model)}`).toBe(false);
      // The exact assertion that would have caught the production failure, now at
      // the call: what dispatches is a real provider and model, never "undefined".
      expect(dispatched(cfg)).toMatchObject({ provider: 'google', model: 'gemini-test' });
    }
  });

  it('an explicit provider override still wins over the default', () => {
    const def = expandChain(chainById('exec-ops.daily-briefing'), {
      params: { orgId: 'org-1', provider: 'openai', model: 'gpt-4o' },
    });
    const ai = def.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    expect((ai.config as Record<string, unknown>).provider).toBe('openai');
    expect((ai.config as Record<string, unknown>).model).toBe('gpt-4o');
  });
});

describe('EVERY shipped chain: no AI node can dispatch with an unresolved provider', () => {
  const AI = new Set(['core.ai.chatCompletion', 'core.ai.structuredOutput']);

  it('no expanded AI node carries an unresolved token or undefined provider/model', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const { chain } of listChains()) {
      if (!chain.dag.nodes.some((n) => AI.has(n.typeId))) continue;
      // Supply every REQUIRED param with a placeholder — expansion now refuses
      // without them (chain_missing_required_param), which is itself the point.
      const required = ((chain.parameters as { required?: string[] })?.required) ?? [];
      const params = Object.fromEntries(required.map((k) => [k, `test-${k}`]));
      let def;
      try { def = expandChain(chain, { params }); } catch (err) {
        offenders.push(`${chain.chainId}: expansion threw ${String(err)}`);
        continue;
      }
      for (const n of def.nodes) {
        if (!AI.has(n.typeId)) continue;
        checked += 1;
        const cfg = (n.config ?? {}) as Record<string, unknown>;
        for (const k of ['provider', 'model']) {
          if (badValue(cfg[k])) offenders.push(`${chain.chainId}/${n.nodeId}.${k} = ${JSON.stringify(cfg[k])}`);
        }
        const d = dispatched(cfg);
        if (typeof d.provider !== 'string' || !d.provider || typeof d.model !== 'string' || !d.model) {
          offenders.push(`${chain.chainId}/${n.nodeId} dispatches ${JSON.stringify(d)}`);
        }
      }
    }
    expect(checked, 'fixture guard: no AI nodes checked — the walker is broken').toBeGreaterThan(50);
    expect(
      offenders,
      'These AI nodes would dispatch with an unresolved provider — the production failure. '
      + 'Bind the node config to {{params.provider}}/{{params.model}} with NO default (ADR 0903 D7); never a literal or an embedded token.',
    ).toEqual([]);
  });
});

/**
 * NO required-param ENFORCEMENT, deliberately.
 *
 * An earlier cut of this work made `expandChain` refuse a Path-A expansion whose
 * declared-required params had no value. It was reverted: "Use template = just
 * copy — copies without a form" is a documented product contract (asserted by
 * `workflow-from-chain-route.test.ts` and stated in `TemplatePreflightModal`),
 * and `seedWorkflows` expands every seeded chain with no params at all. Refusing
 * would have broken both. The incident is fixed at the call (ADR 0903 D3) — not by
 * refusing the copy, and since D7 not by a vendor default either.
 */
describe('copying a template with blanks stays allowed', () => {
  it('expansion does NOT throw when a required param is blank', () => {
    expect(() => expandChain(chainById('exec-ops.daily-briefing'), { params: {} })).not.toThrow();
  });

  it('...and a call from the blank copy STILL dispatches with a concrete provider, from the run default', () => {
    const def = expandChain(chainById('exec-ops.daily-briefing'), { params: {} });
    const ai = def.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    const cfg = (ai.config ?? {}) as Record<string, unknown>;
    // This is the load-bearing assertion for the incident: even a blank copy
    // dispatches with a real provider instead of "undefined".
    expect(cfg.provider, 'no vendor is pinned (ADR 0903 D7)').toBeUndefined();
    expect(dispatched(cfg)).toMatchObject({ provider: 'google', model: 'gemini-test' });
  });
});
