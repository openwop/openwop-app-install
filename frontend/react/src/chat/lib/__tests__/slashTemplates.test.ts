/**
 * The `/` picker's Templates group rules (the picker-templates ADR; extends
 * ADR 0163 and ADR 0764).
 *
 * Why this exists: the picker used to list only owned workflows, so typing
 * "campaign" answered "no match" while the gallery held campaign templates.
 * The fix offers templates, and these tests pin the four rules that keep it
 * safe: templates show only for a typed query (capped at three); a chain whose
 * feature is off is never offered; without workflow-write the row is disabled;
 * an owned copy (`fromChainId`) replaces the template row. And the invariant:
 * a template row's apply action opens the preflight, it never inserts a slug
 * or runs a chain id.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChainTemplate } from '../../../builder/persistence/backendStore.js';
import type { WorkflowSummaryDTO } from '../../../workflows/workflowsClient.js';
import type { WorkflowMentionEntry } from '../workflowMentions.js';
import type { CommandRegistration } from '../../registry/CommandRegistry.js';

const listWorkflowSummaries = vi.fn<() => Promise<WorkflowSummaryDTO[]>>();
const listChainCatalog = vi.fn<() => Promise<ChainTemplate[]>>();

vi.mock('../../../workflows/workflowsClient.js', () => ({
  listWorkflowSummaries: () => listWorkflowSummaries(),
  listChainCatalog: () => listChainCatalog(),
}));
vi.mock('../../../builder/persistence/localStore.js', () => ({ listSavedWorkflows: () => [] }));
vi.mock('../../../client/demoMode.js', () => ({ demoModeCached: () => false }));
vi.mock('../../../i18n/index.js', () => ({ default: { t: (k: string) => k } }));

let tpl: typeof import('../slashTemplates.js');
let mentions: typeof import('../workflowMentions.js');
beforeEach(async () => {
  listWorkflowSummaries.mockReset().mockResolvedValue([]);
  listChainCatalog.mockReset().mockResolvedValue([]);
  vi.resetModules();
  tpl = await import('../slashTemplates.js');
  mentions = await import('../workflowMentions.js');
});

function chain(chainId: string, label: string, requiredFeatures?: Array<{ id: string; label: string }>): ChainTemplate {
  return {
    chainId, packName: 'pack', label, description: `${label} description`,
    ...(requiredFeatures ? { requirements: { missingNodeTypeIds: [], connections: [], requiredFeatures } } : {}),
  };
}
function owned(workflowId: string, displayName: string, fromChainId?: string): WorkflowMentionEntry {
  return {
    workflowId, displayName, slug: displayName.toLowerCase().replace(/\s+/g, '-'), description: '', toolName: `t_${workflowId}`,
    ...(fromChainId ? { fromChainId } : {}),
  };
}
const ALL_ON = { canWrite: true, featureEnabled: () => true };

const CATALOG = [
  chain('cs.launch', 'Campaign launch'),
  chain('cs.weekly', 'Campaign weekly report'),
  chain('cs.retro', 'Campaign retro'),
  chain('cs.budget', 'Campaign budget review'),
  chain('mi.digest', 'Market intel digest'),
];

describe('buildTemplateGroup', () => {
  it('shows nothing for a bare `/`, however many templates exist', () => {
    expect(tpl.buildTemplateGroup(CATALOG, [], '', ALL_ON)).toEqual({ templates: [], ownedInstead: [], show: false });
    expect(tpl.buildTemplateGroup(CATALOG, [], '   ', ALL_ON).show).toBe(false);
  });

  it('a typed query lists matching templates, at most three, by label or chain id', () => {
    const g = tpl.buildTemplateGroup(CATALOG, [], 'campaign', ALL_ON);
    expect(g.show).toBe(true);
    expect(g.templates.map((r) => r.chainId)).toEqual(['cs.launch', 'cs.weekly', 'cs.retro']);
    expect(tpl.TEMPLATE_ROW_CAP).toBe(3);
    expect(tpl.buildTemplateGroup(CATALOG, [], 'mi.dig', ALL_ON).templates.map((r) => r.chainId)).toEqual(['mi.digest']);
    expect(tpl.buildTemplateGroup(CATALOG, [], 'nothing-like-this', ALL_ON).show).toBe(false);
  });

  it('leaves out a template whose required feature is off for the caller', () => {
    const catalog = [chain('cs.gated', 'Campaign gated', [{ id: 'campaign-studio', label: 'Campaign Studio' }]), chain('cs.open', 'Campaign open')];
    const off = { canWrite: true, featureEnabled: (id: string) => id !== 'campaign-studio' };
    expect(tpl.buildTemplateGroup(catalog, [], 'campaign', off).templates.map((r) => r.chainId)).toEqual(['cs.open']);
    expect(tpl.buildTemplateGroup(catalog, [], 'campaign', ALL_ON).templates.map((r) => r.chainId)).toEqual(['cs.gated', 'cs.open']);
  });

  it('without workflow-write the rows are shown, disabled', () => {
    const g = tpl.buildTemplateGroup(CATALOG, [], 'market', { canWrite: false, featureEnabled: () => true });
    expect(g.templates).toEqual([{ chainId: 'mi.digest', label: 'Market intel digest', description: 'Market intel digest description', disabled: true }]);
  });

  it('an owned copy (fromChainId) replaces its template row', () => {
    const mine = owned('wf.copy.cs-launch.1', 'My launch', 'cs.launch');
    const g = tpl.buildTemplateGroup(CATALOG, [mine, owned('wf.blank.2', 'Hand made')], 'campaign', ALL_ON);
    expect(g.ownedInstead).toEqual([mine]);
    // cs.launch is gone; the cap of three is filled from the rest.
    expect(g.templates.map((r) => r.chainId)).toEqual(['cs.weekly', 'cs.retro', 'cs.budget']);
  });
});

describe('slashRowIntent: a template row opens the preflight, never runs', () => {
  const row = { chainId: 'cs.launch', label: 'Campaign launch', description: '', disabled: false };

  it('a template row yields open-preflight with the chain id and the kept prefix, never an insert', () => {
    expect(tpl.slashRowIntent({ kind: 'template', tpl: row }, '@devon ')).toEqual({ kind: 'open-preflight', chainId: 'cs.launch', prefix: '@devon ' });
  });

  it('a disabled template row and a disabled browse row do nothing', () => {
    expect(tpl.slashRowIntent({ kind: 'template', tpl: { ...row, disabled: true } }, '')).toEqual({ kind: 'none' });
    expect(tpl.slashRowIntent({ kind: 'browse-templates', disabled: true }, '')).toEqual({ kind: 'none' });
    expect(tpl.slashRowIntent({ kind: 'browse-templates', disabled: false }, '')).toEqual({ kind: 'browse-templates', prefix: '' });
  });

  it('only command and owned-workflow rows insert text', () => {
    const cmd: CommandRegistration = { name: '/clear', description: 'd', handler: () => true };
    expect(tpl.slashRowIntent({ kind: 'command', cmd }, '')).toEqual({ kind: 'insert', text: '/clear ' });
    expect(tpl.slashRowIntent({ kind: 'workflow', wf: owned('wf.a', 'Alpha') }, '')).toEqual({ kind: 'insert', text: '/alpha ' });
  });

  it('a cached template is never a `/` workflow the submit path could dispatch', async () => {
    listChainCatalog.mockResolvedValue([chain('cs.launch', 'Campaign launch')]);
    listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf.blank.1', kind: 'workflow', name: 'Alpha', nodeCount: 1, createdAt: 't', updatedAt: 't' }]);
    expect(await tpl.refreshChainTemplateCache()).toBe(true);
    await mentions.refreshWorkflowMentionCache();
    expect(tpl.listCachedChainTemplates().map((c) => c.chainId)).toEqual(['cs.launch']);
    // The mention list (what `/slug` resolves against) holds owned ids only.
    expect(mentions.listWorkflowMentions().map((e) => e.workflowId)).toEqual(['wf.blank.1']);
    for (const text of ['/campaign-launch', '/cs-launch', '/cs.launch']) {
      expect(mentions.detectWorkflowSlashMention(text), text).toBeNull();
    }
  });
});

describe('the catalog cache', () => {
  it('a failed read keeps the last good catalog and reports false', async () => {
    listChainCatalog.mockResolvedValueOnce([chain('cs.launch', 'Campaign launch')]);
    expect(await tpl.refreshChainTemplateCache()).toBe(true);
    listChainCatalog.mockRejectedValueOnce(new Error('429'));
    expect(await tpl.refreshChainTemplateCache()).toBe(false);
    expect(tpl.cachedChainTemplate('cs.launch')?.label).toBe('Campaign launch');
  });

  it('carries fromChainId from the ownership summary onto the mention entry', async () => {
    listWorkflowSummaries.mockResolvedValue([
      { workflowId: 'wf.copy.cs-launch.1', kind: 'workflow', name: 'Campaign launch', nodeCount: 3, createdAt: 't', updatedAt: 't', fromChainId: 'cs.launch' },
      { workflowId: 'wf.blank.2', kind: 'workflow', name: 'Hand made', nodeCount: 1, createdAt: 't', updatedAt: 't' },
    ]);
    await mentions.refreshWorkflowMentionCache();
    const byId = new Map(mentions.listWorkflowMentions().map((e) => [e.workflowId, e]));
    expect(byId.get('wf.copy.cs-launch.1')?.fromChainId).toBe('cs.launch');
    expect(byId.get('wf.blank.2')).not.toHaveProperty('fromChainId');
  });
});
