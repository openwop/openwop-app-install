/**
 * ADR 0507 — two findings, one root cause: a chain param with no value.
 *
 * FAMILY 1 (whole-value, ADR 0504 already saw it): `"{{params.x}}"` freezes to
 * `undefined`, the key vanishes, the node fails LOUDLY. 9 of the 52 actually-seeded
 * chains carry one.
 *
 * FAMILY 2 (embedded, INVISIBLE until now): `"…Invoice: {{params.x}}"` freezes to
 * `''` — a valid string — so nothing fails. `finance.invoice-ap` declares
 * `invoiceText` REQUIRED and its seeded prompt reads
 *
 *     "Extract vendor, line items, amounts, and totals from the invoice. Invoice: "
 *
 * with nothing after it. The model is asked to extract line items from nothing, it
 * obliges, and the fabrication flows to an approval gate. Absent input that FAILS is
 * a bug; absent input that SUCCEEDS with invented content is worse. 36 chains carry
 * this, including PR review, email triage and document summarisation.
 *
 * NOTE ON POPULATION (the correction this ADR carries): `seedWorkflows` seeds only
 * ZERO-CONFIG chains, so the seeded set is 52 — not the 169 loaded. ADR 0504's
 * "114 of 169 seeded" measured `listChains()` instead of the seeded subset.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks, listChains, expandChain, findUnfilledExpansionParams,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const PACK_ROOT = join(import.meta.dirname, '../../../examples/workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [PACK_ROOT] });
});

const chainById = (id: string) => {
  const found = listChains().find((c) => c.chain.chainId === id);
  expect(found, `chain ${id} not loaded — renamed?`).toBeDefined();
  return found!.chain;
};

describe('the embedded-token family is now visible', () => {
  it('flags the invoice extractor whose prompt loses its invoice', () => {
    const def = expandChain(chainById('finance.invoice-ap'), { params: {} }) as unknown as WorkflowDefinition;
    const found = findUnfilledExpansionParams(def);
    const invoice = found.find((f) => f.param === 'invoiceText');
    expect(invoice, 'invoiceText is REQUIRED and embedded in the system prompt').toBeDefined();
    expect(invoice!.embedded, 'must be marked embedded — it froze to empty, it did not vanish').toBe(true);
  });

  it('the prompt now carries a VISIBLE marker where the input is missing (CHAIN-EMBED-1)', () => {
    // §UPDATED — this test used to assert the DEFECT: that the prompt trailed off at
    // "…Invoice: " as a perfectly valid string, which is what made the family silent.
    // That was correct evidence at the time and is now stale, because the substituter
    // marks a missing REQUIRED embedded param instead of collapsing it to ''.
    // Keeping the explanation, flipping the assertion — a test that pins a defect
    // becomes a lie the moment the defect is fixed.
    const def = expandChain(chainById('finance.invoice-ap'), { params: {} }) as unknown as WorkflowDefinition;
    const extract = def.nodes.find((n) => n.nodeId.endsWith('_extract'))!;
    const prompt = (extract.config as Record<string, unknown>).systemPrompt as string;
    expect(typeof prompt).toBe('string');
    expect(prompt, 'a model must see a placeholder, not an absence it will fill in').toContain('[missing: invoiceText]');
    expect(prompt.trimEnd().endsWith('Invoice:'), 'the prompt must no longer just trail off').toBe(false);
  });

  it('still reports an embedded finding even though the live value is long and truthy', () => {
    // The re-check that works for family 1 ("is it still empty?") would DROP this,
    // because the absence is inside the string rather than instead of it.
    const def = expandChain(chainById('finance.invoice-ap'), { params: {} }) as unknown as WorkflowDefinition;
    expect(findUnfilledExpansionParams(def).some((f) => f.embedded)).toBe(true);
  });

  it('records NOTHING once the param is supplied', () => {
    const def = expandChain(chainById('finance.invoice-ap'), { params: { invoiceText: 'ACME Ltd — 2 widgets — $50' } }) as unknown as WorkflowDefinition;
    expect(findUnfilledExpansionParams(def).filter((f) => f.param === 'invoiceText')).toHaveLength(0);
  });

  it('does not flag a chain whose params all resolve', () => {
    // Guards the detector against the opposite failure — flagging everything.
    const clean = listChains().filter(({ chain }) => {
      const d = expandChain(chain, { params: {} }) as unknown as WorkflowDefinition;
      return findUnfilledExpansionParams(d).length === 0;
    });
    expect(clean.length, 'some chains must be clean or the detector is vacuous').toBeGreaterThan(20);
  });
});

describe('deferred seeding does not move node ids', () => {
  it('is byte-identical across every loaded chain — the property that makes the re-seed safe', () => {
    const chains = listChains();
    expect(chains.length, 'registry must be loaded').toBeGreaterThan(100);
    const moved: string[] = [];
    for (const { chain } of chains) {
      const a = expandChain(chain, {}) as unknown as WorkflowDefinition;
      const b = expandChain(chain, { deferred: true }) as unknown as WorkflowDefinition;
      if (a.nodes.map((n) => n.nodeId).join('|') !== b.nodes.map((n) => n.nodeId).join('|')) moved.push(chain.chainId);
    }
    expect(moved, 'a moved node id breaks replay for existing runs — this is the migration gate').toEqual([]);
  });

  it('turns the unfilled params into run-suppliable variables', () => {
    // The payoff: `ui/RunInputsForm` renders from `variables[]`, which was empty
    // under expansion-time seeding, so the form showed nothing and Run stayed on.
    const chain = chainById('finance.invoice-ap');
    const frozen = expandChain(chain, {}) as unknown as WorkflowDefinition;
    const deferred = expandChain(chain, { deferred: true }) as unknown as WorkflowDefinition;
    expect(frozen.variables ?? []).toHaveLength(0);
    expect((deferred.variables ?? []).length).toBeGreaterThan(0);
  });

  it('keeps the token in the minted prompt template instead of baking the empty string', () => {
    // This is WHY deferred fixes family 2, not just family 1.
    const deferred = expandChain(chainById('finance.invoice-ap'), { deferred: true }) as unknown as WorkflowDefinition;
    const minted = (deferred.metadata as { mintedPromptTemplates?: Array<{ text: string }> }).mintedPromptTemplates ?? [];
    expect(minted.length, 'the inline prompt must be lifted to a template').toBeGreaterThan(0);
    expect(minted.some((t) => /\{\{[^}]*invoiceText[^}]*\}\}/.test(t.text)), 'the template must KEEP the token for run-time interpolation').toBe(true);
  });
});
