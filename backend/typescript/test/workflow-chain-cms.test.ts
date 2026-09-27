/**
 * CMS localization workflow-chain pack (ADR 0204 C6 / RFC 0013).
 *
 * `cms.localize-and-submit` chains the feature.cms.nodes governed verbs:
 * get-draft-page → translate-section → update-section-draft → submit-page.
 * There is deliberately NO publish node (the Phase-C architecture ruling:
 * nodes draft and submit; humans publish). The pack loads from the in-tree
 * examples root like every shipped chain pack.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

const CHAIN = 'cms.localize-and-submit';
const CMS_NODE_TYPEIDS = new Set([
  'feature.cms.nodes.get-draft-page',
  'feature.cms.nodes.translate-section',
  'feature.cms.nodes.update-section-draft',
  'feature.cms.nodes.submit-page',
]);

describe('feature.cms.workflows chain pack', () => {
  it('loads and validates against the manifest schema', () => {
    const entry = getChain(CHAIN);
    expect(entry, 'cms.localize-and-submit must be registered').toBeTruthy();
    expect((entry!.chain.parameters as { required?: string[] }).required).toEqual(['orgId', 'pageId', 'sectionId', 'targetLocale']);
  });

  it('references ONLY the shipped CMS node typeIds, and NO publish verb', () => {
    const chain = getChain(CHAIN)!.chain;
    for (const node of chain.dag.nodes) {
      expect(CMS_NODE_TYPEIDS.has(node.typeId), `unknown typeId ${node.typeId}`).toBe(true);
      expect(node.typeId).not.toMatch(/publish/);
    }
  });

  it('RFC 0013 Path A — expands deterministically; params FROZEN into config (no residual tokens)', () => {
    const chain = getChain(CHAIN)!.chain;
    const params = { orgId: 'org:x', pageId: 'page:y', sectionId: 'sec:z', targetLocale: 'pt-BR' };
    const def = expandChain(chain, { params });
    expect(expandChain(chain, { params })).toEqual(def); // byte-identical
    // Path A: params are FROZEN into node config at expansion — no run-overridable
    // variables[]; the persisted definition carries the concrete value, not a token.
    expect(def.variables).toBeUndefined();
    const read = def.nodes.find((n) => n.nodeId.endsWith('_read'));
    expect(JSON.stringify(read?.config)).toContain('page:y');           // frozen value
    expect(JSON.stringify(read?.config)).not.toContain('{{inputs.pageId}}');
    expect(JSON.stringify(read?.config)).not.toContain('{{params.pageId}}');
  });
});
