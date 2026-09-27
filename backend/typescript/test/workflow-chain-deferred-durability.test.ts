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
    expect(found && found !== 'ambiguous').toBeTruthy();
  });

  it('is idempotent and tolerant of absent / malformed metadata', () => {
    const meta = {
      mintedPromptTemplates: [
        { templateId: 'chainmint-idem-xyz', version: '1.0.0', kind: 'system', text: 'x', variables: [] },
      ],
    };
    ensureMintedTemplatesRegistered(meta);
    expect(() => ensureMintedTemplatesRegistered(meta)).not.toThrow(); // idempotent re-mint
    expect(() => ensureMintedTemplatesRegistered(undefined)).not.toThrow();
    expect(() => ensureMintedTemplatesRegistered(null)).not.toThrow();
    expect(() => ensureMintedTemplatesRegistered({ mintedPromptTemplates: 'nope' })).not.toThrow();
    expect(() => ensureMintedTemplatesRegistered({ mintedPromptTemplates: [42, null, {}] })).not.toThrow();
  });

  it('a deferred-expanded workflow carries re-registerable minted templates on metadata', () => {
    const chain: WorkflowChain = {
      chainId: 'test.durable',
      version: '1.0.0',
      label: 'D',
      description: 'd',
      parameters: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } },
      dag: { nodes: [{ id: 'gen', typeId: 'core.ai.chatCompletion', config: { systemPrompt: 'On {{params.topic}}.' } }] },
    };
    const def = expandChain(chain, { deferred: true, params: { topic: 'X' } });
    const minted = def.metadata?.mintedPromptTemplates as Array<{ templateId: string }>;
    expect(minted.length).toBe(1);
    // Re-registration from the definition metadata is a no-op-safe idempotent call
    // (executeRun does exactly this at run-start for every run).
    expect(() => ensureMintedTemplatesRegistered(def.metadata)).not.toThrow();
    expect(getTemplate(minted[0].templateId)).toBeTruthy();
  });
});
