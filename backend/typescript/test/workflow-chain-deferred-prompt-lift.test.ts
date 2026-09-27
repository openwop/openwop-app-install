/**
 * RFC 0124 G3 (WCP4 increment 2b) — inline-prompt-body lift + sensitive redaction.
 *
 * Deferred mode lifts an inline `config.systemPrompt`/`userPrompt` carrying
 * `{{params.x}}` into a MINTED host PromptTemplate (whose `text` holds a
 * `{{varName}}` `source:"variable"` slot) and points the node's `*PromptRef` at it —
 * so a prompt-body param defers portably, and a SENSITIVE param can reach a prompt
 * safely (redacted at compose, never frozen). This exercises the expansion-side lift
 * + the compose-layer redaction/fence primitive; the run-path binding + gated
 * end-to-end leg are the following slice.
 */
import { describe, it, expect } from 'vitest';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { getTemplate } from '../src/host/promptStore.js';
import { composePromptTemplate, type PromptTemplate } from '../src/host/promptCompose.js';

const promptChain = (overrides: Partial<WorkflowChain> = {}): WorkflowChain => ({
  chainId: 'test.prompt-lift',
  version: '1.0.0',
  label: 'Prompt lift',
  description: 'd',
  parameters: {
    type: 'object',
    required: ['topic'],
    properties: { topic: { type: 'string', description: 'the subject' } },
  },
  dag: {
    nodes: [
      {
        id: 'gen',
        typeId: 'core.ai.chatCompletion',
        config: { systemPrompt: 'You are an analyst. Write a brief on {{params.topic}}.' },
      },
    ],
  },
  ...overrides,
});

describe('RFC 0124 G3 — inline-prompt-body lift', () => {
  it('lifts an inline systemPrompt into a minted PromptTemplate + systemPromptRef (no residual token)', () => {
    const def = expandChain(promptChain(), { deferred: true, params: { topic: 'AI ops' } });
    const node = def.nodes[0];
    const cfg = node.config as { systemPrompt?: unknown; systemPromptRef?: { templateId: string; version: string } };

    // inline body replaced by a *PromptRef; no inline systemPrompt, no residual token.
    expect(cfg.systemPrompt).toBeUndefined();
    expect(cfg.systemPromptRef).toBeDefined();
    expect(JSON.stringify(node.config)).not.toContain('{{params');

    // the minted template is registered + resolvable via the store.
    const ref = cfg.systemPromptRef!;
    const found = getTemplate(ref.templateId, { version: ref.version });
    expect(found && found !== 'ambiguous').toBeTruthy();
    const tmpl = (found as { template: PromptTemplate }).template;

    // template text carries a {{varName}} slot (the prefixed materialized var), NOT {{params.*}}.
    const topicVar = (def.variables ?? []).find((v) => v.name.endsWith('_topic'))!;
    expect(tmpl.text).toContain(`{{${topicVar.name}}}`);
    expect(tmpl.text).not.toContain('{{params.topic}}');
    // the template declares the variable as source:variable.
    const decl = (tmpl.variables ?? []).find((v) => v.name === topicVar.name)!;
    expect(decl.source).toBe('variable');

    // self-contained: the minted template rides on the definition metadata.
    const minted = def.metadata?.mintedPromptTemplates as PromptTemplate[];
    expect(minted.some((t) => t.templateId === ref.templateId)).toBe(true);
  });

  it('is deterministic: re-expanding the same chain+params re-mints the same template id (idempotent)', () => {
    const a = expandChain(promptChain(), { deferred: true, params: { topic: 'X' } });
    const b = expandChain(promptChain(), { deferred: true, params: { topic: 'X' } });
    const refA = (a.nodes[0].config as { systemPromptRef: { templateId: string } }).systemPromptRef;
    const refB = (b.nodes[0].config as { systemPromptRef: { templateId: string } }).systemPromptRef;
    expect(refA.templateId).toBe(refB.templateId);
  });

  it('a SENSITIVE param in a prompt body now LIFTS (no longer fail-closed) and marks the template variable sensitive', () => {
    const chain = promptChain({
      parameters: {
        type: 'object',
        required: ['apiKey'],
        properties: { apiKey: { type: 'string', 'x-openwop-sensitive': true } },
      },
      dag: {
        nodes: [{ id: 'gen', typeId: 'core.ai.chatCompletion', config: { systemPrompt: 'Auth with {{params.apiKey}} then summarize.' } }],
      },
    });
    const def = expandChain(chain, { deferred: true, params: { apiKey: 'secret-xyz' } });
    const ref = (def.nodes[0].config as { systemPromptRef: { templateId: string; version: string } }).systemPromptRef;
    const tmpl = (getTemplate(ref.templateId, { version: ref.version }) as { template: PromptTemplate }).template;
    const keyVar = (def.variables ?? []).find((v) => v.name.endsWith('_apiKey'))!;
    expect((tmpl.variables ?? []).find((v) => v.name === keyVar.name)!.sensitive).toBe(true);
    // secret value NEVER appears in the persisted definition or the minted template.
    expect(JSON.stringify(def)).not.toContain('secret-xyz');
    expect(JSON.stringify(tmpl)).not.toContain('secret-xyz');
  });

  it('a SENSITIVE param in a NON-prompt config key still FAILS CLOSED (freeze would leak)', () => {
    const chain = promptChain({
      parameters: {
        type: 'object',
        required: ['apiKey'],
        properties: { apiKey: { type: 'string', 'x-openwop-sensitive': true } },
      },
      dag: { nodes: [{ id: 'gen', typeId: 'core.ai.chatCompletion', config: { authHeader: '{{params.apiKey}}' } }] },
    });
    expect(() => expandChain(chain, { deferred: true, params: { apiKey: 'x' } })).toThrow(
      /sensitive_param_not_deferrable/,
    );
  });
});

describe('RFC 0124 §Security — compose redaction + untrusted fence on a sensitive variable', () => {
  it('a sensitive variable delivers its value to the model but REDACTS in observability; untrusted → fenced', async () => {
    const template: PromptTemplate = {
      templateId: 'test.sensitive.compose',
      version: '1.0.0',
      kind: 'system',
      text: 'Use key {{apiKey}} to authenticate.',
      variables: [{ name: 'apiKey', type: 'string', required: true, source: 'variable', sensitive: true }],
    };
    const composed = await composePromptTemplate({
      templateId: template.templateId,
      template, // inline (minted) template
      bindings: { apiKey: 'sk-live-123' },
      bindingTrust: { apiKey: 'untrusted' },
      observability: 'full',
    });
    // the model-facing body carries the real value, fenced as untrusted (R1).
    expect(composed.composed).toContain('<UNTRUSTED>sk-live-123</UNTRUSTED>');
    expect(composed.contentTrust).toBe('untrusted');
    // the observability payload REDACTS it (SR-1) — the secret never surfaces there.
    expect(JSON.stringify(composed.variableBindings ?? {})).toContain('[REDACTED:apiKey]');
    expect(JSON.stringify(composed.variableBindings ?? {})).not.toContain('sk-live-123');
  });

  it('a non-sensitive variable is NOT redacted in observability', async () => {
    const template: PromptTemplate = {
      templateId: 'test.plain.compose',
      version: '1.0.0',
      kind: 'system',
      text: 'Topic is {{topic}}.',
      variables: [{ name: 'topic', type: 'string', required: true, source: 'variable' }],
    };
    const composed = await composePromptTemplate({
      templateId: template.templateId,
      template,
      bindings: { topic: 'AI ops' },
      observability: 'full',
    });
    expect(JSON.stringify(composed.variableBindings ?? {})).toContain('AI ops');
  });
});
