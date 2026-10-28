/**
 * RFC 0124 G3 hardening — minted-template DURABILITY across instance/restart.
 *
 * `registerMintedTemplate` populates only the EXPANDING instance's in-memory host
 * store. A run may execute on a different instance (Cloud Run is multi-instance) or
 * after a restart, where that template does not exist → the lifted `*PromptRef`
 * would resolve to nothing and the prompt body compose empty. The definition carries
 * its minted templates on `metadata.mintedPromptTemplates`; `executeRun` re-registers
 * them at run-start via `ensureMintedTemplatesRegistered` so `getTemplate` resolves on
 * any instance. This asserts that re-registration path directly (a template that was
 * NEVER minted in this process becomes resolvable from metadata alone).
 *
 * Sabotage-witnessed (wave 64): dropping the re-register (8fw5g1-dd-reregister → case 1),
 * the array guard (dd-tolerant → case 2) and the metadata carry (dd-metadata-carry →
 * case 3). Case 3 does NOT witness re-registration: `expandChain` itself registers the
 * minted template in-process (workflowChainPackLoader.ts `registerMintedTemplate`), so
 * its claim is the metadata CARRY that a different instance re-registers from.
 */
import { describe, it, expect } from 'vitest';
import { getTemplate, ensureMintedTemplatesRegistered } from '../src/host/promptStore.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';

describe('RFC 0124 — minted-template durability (re-register from metadata)', () => {
  it('a template never minted in this process becomes resolvable from metadata (cross-instance)', () => {
    const meta = {
      mintedPromptTemplates: [
        {
          templateId: 'chainmint-neverseen-abcdef-node-system',
          version: '1.0.0',
          kind: 'system',
          text: 'Brief on {{some_prefixed_topic}}.',
          variables: [{ name: 'some_prefixed_topic', type: 'string', required: true, source: 'variable' }],
        },
      ],
    };
    // Not present — simulates a run landing on an instance that never ran from-chain.
    expect(getTemplate('chainmint-neverseen-abcdef-node-system')).toBeNull();

    ensureMintedTemplatesRegistered(meta);

    const found = getTemplate('chainmint-neverseen-abcdef-node-system');
    if (found === null || found === 'ambiguous') throw new Error(`expected one resolved template, got ${String(found)}`);
    expect(found.template.text).toBe('Brief on {{some_prefixed_topic}}.');
    expect(found.template.version).toBe('1.0.0');
  });

  it('is idempotent and tolerant of absent / malformed metadata', () => {
    const meta = {
      mintedPromptTemplates: [
        { templateId: 'chainmint-idem-xyz', version: '1.0.0', kind: 'system', text: 'x', variables: [] },
      ],
    };
    ensureMintedTemplatesRegistered(meta);
    expect(() => ensureMintedTemplatesRegistered(meta)).not.toThrow(); // idempotent re-mint
    // …and the double register left ONE resolvable template, not an ambiguity.
    const once = getTemplate('chainmint-idem-xyz');
    if (once === null || once === 'ambiguous') throw new Error(`re-mint left ${String(once)}`);
    expect(once.template.text).toBe('x');
    expect(() => ensureMintedTemplatesRegistered(undefined)).not.toThrow();
    expect(() => ensureMintedTemplatesRegistered(null)).not.toThrow();
    expect(() => ensureMintedTemplatesRegistered({ mintedPromptTemplates: 'nope' })).not.toThrow();
    expect(() => ensureMintedTemplatesRegistered({ mintedPromptTemplates: [42, null, {}] })).not.toThrow();
  });

  it('a deferred-expanded workflow carries its minted template on metadata (what another instance re-registers from)', () => {
    const chain: WorkflowChain = {
      chainId: 'test.durable',
      version: '1.0.0',
      label: 'D',
      description: 'd',
      parameters: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } },
      dag: { nodes: [{ id: 'gen', typeId: 'core.ai.chatCompletion', config: { systemPrompt: 'On {{params.topic}}.' } }] },
    };
    const def = expandChain(chain, { deferred: true, params: { topic: 'X' } });
    const minted = def.metadata?.mintedPromptTemplates;
    if (!Array.isArray(minted)) throw new Error('deferred expansion carried no mintedPromptTemplates');
    expect(minted.length).toBe(1);
    const carried = minted[0] as { templateId?: unknown; text?: unknown };
    expect(typeof carried.templateId).toBe('string');
    // The carried body is the lifted prompt (the param prefixed into a variable), not empty.
    expect(String(carried.text)).toMatch(/^On \{\{[a-z0-9_]*topic\}\}\.$/);
    // Re-registration from the definition metadata is a no-op-safe idempotent call
    // (executeRun does exactly this at run-start for every run).
    expect(() => ensureMintedTemplatesRegistered(def.metadata)).not.toThrow();
    expect(getTemplate(String(carried.templateId))).toBeTruthy();
  });
});
