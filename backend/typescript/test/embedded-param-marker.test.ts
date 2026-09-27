/**
 * CHAIN-EMBED-1 — an embedded token for a REQUIRED param no longer collapses to `''`.
 *
 * A whole-value `"{{params.x}}"` freezes to `undefined`, the key vanishes, and the
 * node fails loudly. An EMBEDDED one collapsed to an empty string — a perfectly valid
 * prompt — so `finance.invoice-ap` shipped
 *
 *     "Extract vendor, line items, amounts, and totals from the invoice. Invoice: "
 *
 * and a model was asked to extract line items from nothing. It obliges, and the
 * fabrication reaches an approval gate. 16 chains carry the pattern, including
 * `devops.pr-review` (diffText), `inbox.triage` (emailText) and
 * `knowledge.doc-summarizer` (documentText).
 *
 * `tokenSubstitution.ts` was the single point where every one of them degraded, so
 * the fix is one branch there rather than 16 pack re-authorings.
 *
 * THE LOAD-BEARING NEGATIVE: an OPTIONAL embedded param must still collapse to `''`.
 * A marker there would put noise into every prompt that mentions an optional value —
 * trading a silent-fabrication bug for a visible-garbage one across the whole corpus.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { join } from 'node:path';
import { resolveTokenString, substituteTokensDeep, MISSING_REQUIRED_MARKER } from '../src/host/tokenSubstitution.js';
import {
  loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const PACK_ROOT = join(import.meta.dirname, '../../../examples/workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [PACK_ROOT] });
});

describe('the substituter marks a missing REQUIRED embedded param', () => {
  const required = new Set(['invoiceText']);

  it('emits a visible marker instead of an empty string', () => {
    const out = resolveTokenString('Invoice: {{params.invoiceText}}', 'params', {}, required);
    expect(out).toBe(`Invoice: ${MISSING_REQUIRED_MARKER('invoiceText')}`);
    expect(String(out)).toContain('[missing: invoiceText]');
  });

  it('leaves an OPTIONAL embedded param collapsing to empty — the load-bearing negative', () => {
    // No `requiredNames` entry ⇒ today's behaviour. A marker here would add noise to
    // every prompt mentioning an optional value.
    const out = resolveTokenString('Note: {{params.supplierHint}}', 'params', {}, required);
    expect(out).toBe('Note: ');
  });

  it('is inert when no required set is supplied at all', () => {
    // Every non-chain caller of the shared substituter must be unaffected.
    expect(resolveTokenString('Invoice: {{params.invoiceText}}', 'params', {})).toBe('Invoice: ');
  });

  it('never marks a param that HAS a value', () => {
    expect(resolveTokenString('Invoice: {{params.invoiceText}}', 'params', { invoiceText: 'ACME $50' }, required))
      .toBe('Invoice: ACME $50');
  });

  it('does not touch WHOLE-VALUE tokens — those still vanish and fail loudly', () => {
    // The other family keeps its (correct, loud) behaviour.
    expect(resolveTokenString('{{params.invoiceText}}', 'params', {}, required)).toBeUndefined();
  });

  it('recurses through nested config objects and arrays', () => {
    const out = substituteTokensDeep(
      { a: { b: 'X {{params.invoiceText}}' }, c: ['Y {{params.invoiceText}}'] },
      'params', {}, required,
    );
    expect(out.a.b).toContain('[missing: invoiceText]');
    expect(out.c[0]).toContain('[missing: invoiceText]');
  });
});

describe('the real chains stop fabricating', () => {
  it('finance.invoice-ap no longer asks a model to read an invoice that is not there', () => {
    const found = listChains().find((c) => c.chain.chainId === 'finance.invoice-ap');
    expect(found, 'fixture guard: the chain must be loaded or this proves nothing').toBeTruthy();
    const def = expandChain(found!.chain, { params: {} }) as unknown as WorkflowDefinition;
    const extract = def.nodes.find((n) => n.nodeId.endsWith('_extract'))!;
    const prompt = String((extract.config as Record<string, unknown>).systemPrompt);
    // Before: "…from the invoice. Invoice: " — valid, and silently wrong.
    expect(prompt).toContain('[missing: invoiceText]');
    expect(prompt.trimEnd().endsWith('Invoice:'), 'the prompt must no longer just trail off').toBe(false);
  });

  it('supplying the param produces a clean prompt with no marker', () => {
    const found = listChains().find((c) => c.chain.chainId === 'finance.invoice-ap')!;
    const def = expandChain(found.chain, { params: { invoiceText: 'ACME Ltd — 2 widgets — $50' } }) as unknown as WorkflowDefinition;
    const extract = def.nodes.find((n) => n.nodeId.endsWith('_extract'))!;
    const prompt = String((extract.config as Record<string, unknown>).systemPrompt);
    expect(prompt).toContain('ACME Ltd');
    expect(prompt).not.toContain('[missing:');
  });

  it('an optional param left blank adds NO marker to any shipped chain', () => {
    // Corpus-wide guard against the noise regression: expanding every chain with no
    // params must only ever mark params the chain itself declares required.
    const chains = listChains();
    expect(chains.length, 'registry must be loaded').toBeGreaterThan(100);
    for (const { chain } of chains) {
      const req = new Set(((chain.parameters as { required?: string[] } | undefined)?.required) ?? []);
      const def = expandChain(chain, { params: {} }) as unknown as WorkflowDefinition;
      const blob = JSON.stringify(def.nodes);
      for (const m of blob.matchAll(/\[missing: ([a-zA-Z0-9_]+)\]/g)) {
        expect(req.has(m[1]!), `${chain.chainId} marked OPTIONAL param ${m[1]}`).toBe(true);
      }
    }
  });
});
