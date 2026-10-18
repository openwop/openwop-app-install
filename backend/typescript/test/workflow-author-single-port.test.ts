/**
 * ADR 0782 — the workflow-author model is told about single-port nodes, and the
 * rule is ENFORCED at both authoring doors (validate + persist), not merely
 * stated. A `targetInput` edge into a single-port node routes at run time but has
 * no handle on the builder canvas, so it is invisible to whoever opens the
 * workflow next.
 *
 * Sabotage witnesses (grade-tests w18): `ports` dropped from the authoring
 * catalog or from the draft prompt's menu; rule 8 weakened in the draft prompt;
 * the single-port check removed from `validateAuthoredWorkflow` (validate door)
 * or from `persistAuthoredWorkflow` (persist door); the persona's rule deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';
import { buildNodeCatalog, findSinglePortEdgeViolations } from '../src/host/nodeCatalogBuilder.js';
import { buildAuthoringCatalog, persistAuthoredWorkflow, validateAuthoredWorkflow } from '../src/features/workflow-author/workflowAuthorService.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';

const PACK = 'vendor.test.author-single-port';
let dir = '';
const REPO = join(__dirname, '..', '..', '..');

beforeAll(() => {
  dir = join(resolveDefaultPackDir(), PACK);
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'schemas', 'in.json'), JSON.stringify({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] }));
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: PACK, version: '1.0.0', kind: 'node',
    nodes: [
      { typeId: 'vendor.test.asp.single', version: '1.0.0', label: 'S', inputSchemaRef: 'schemas/in.json', 'x-ports': 'single' },
      { typeId: 'vendor.test.asp.src', version: '1.0.0', label: 'Src' },
    ],
  }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The candidate as a model sends it: the WIRE shape (edge spelled `id`), so it
 *  goes through the shared validator before any internal-typed helper sees it. */
const def = (targetInput?: string): Record<string, unknown> => ({
  workflowId: 'wf.asp', nodes: [{ nodeId: 's', typeId: 'vendor.test.asp.src' }, { nodeId: 't', typeId: 'vendor.test.asp.single' }],
  edges: [{ id: 'e1', sourceNodeId: 's', targetNodeId: 't', ...(targetInput ? { targetInput } : {}) }],
});

describe('ADR 0782 — single-port nodes in the authoring lane', () => {
  it('the authoring catalog (chat + meta-workflow menu) carries ports:"single"', () => {
    const n = buildAuthoringCatalog().nodes.find((x) => x.typeId === 'vendor.test.asp.single');
    expect(n?.ports).toBe('single');
  });

  it('the draft node puts it in front of the model, with the rule', async () => {
    const { buildSystemPrompt } = (await import(join(REPO, 'packs/feature.workflow-author.nodes/index.mjs'))) as { buildSystemPrompt: (c: { nodes: unknown[] }) => string };
    const prompt = buildSystemPrompt({ nodes: buildAuthoringCatalog().nodes });
    // The menu is the prompt's last line, as JSON.
    const menu = JSON.parse(prompt.trim().split('\n').pop() as string) as Array<{ typeId: string; ports?: string }>;
    expect(menu.find((n) => n.typeId === 'vendor.test.asp.single')?.ports).toBe('single');
    expect(menu.find((n) => n.typeId === 'vendor.test.asp.src')).not.toHaveProperty('ports');
    expect(prompt).toMatch(/ports:"single" MUST NOT set targetInput/);
  });

  it('validate REJECTS a targetInput edge into a single-port node; a plain edge passes', () => {
    const bad = findSinglePortEdgeViolations(validateWorkflowDefinition(def('a')), buildNodeCatalog());
    expect(bad).toHaveLength(1);
    // The fixture types are real catalog entries, so the full validator runs.
    const v = validateAuthoredWorkflow(def('a'));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/single input port/);
    expect(findSinglePortEdgeViolations(validateWorkflowDefinition(def()), buildNodeCatalog())).toEqual([]);
  });

  it('persist REJECTS the same edge — the write door enforces the rule, not only validate', async () => {
    // The check sits before any ownership/storage read, so a model that skips
    // `validate` (or revises after it) is still refused at the write.
    await expect(persistAuthoredWorkflow(def('a'), { tenantId: 't-asp' }))
      .rejects.toMatchObject({ code: 'validation_error', details: { reason: 'single_port_target_input' } });
  });

  it('every model-facing prompt states the rule and none claims config supplies inputs', () => {
    const persona = readFileSync(join(REPO, 'packs/vendor.openwop-app.workflow-author.agents/prompts/workflow-architect.md'), 'utf8');
    const packSrc = readFileSync(join(REPO, 'packs/feature.workflow-author.nodes/index.mjs'), 'utf8');
    for (const [name, src] of [['persona', persona], ['draft prompt', packSrc]] as const) {
      expect(src, `${name} states the single-port rule`).toMatch(/ports:\s*"single"/);
      expect(src, `${name} must not claim config supplies inputs`).not.toMatch(/\(or via config\)/);
    }
  });
});
