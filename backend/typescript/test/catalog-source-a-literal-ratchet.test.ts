/**
 * ADR 0764 D6 (`CHATWF-7`) — the catalog source-A literal ladder is ratcheted.
 *
 * `host/index.ts` resolves a handful of workflow ids as in-tree literals before
 * the chain-backed lookup: the chat transport (`openwop-app.conversation`), its
 * replay-only predecessor, the deep @mention wrapper, and four demo workflows.
 * They are infrastructure, not user workflows — but the ADR 0472 ratchet only
 * catches the deleted `builtinWorkflows` field, so a NEW user workflow hidden in
 * this ladder compiled green, invisible to `/builder` and the `/` picker.
 *
 * This pins the set. Shrink-only: removing an entry is fine (update the list);
 * adding one fails here. A new workflow ships as a chain pack (CLAUDE.md
 * "Workflows — never hard-code").
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_WORKFLOWS } from '../src/host/exampleWorkflows.js';

const ALLOWED = [
  'openwop-app.uppercase',
  'openwop-app.approval-gate',
  'openwop-app.a2ui-clarify',
  'openwop-app.web.research',
  'openwop-app.chat.turn',
  'openwop-app.conversation',
  'AGENT_MENTION_WORKFLOW_ID',
].sort();

describe('catalog source-A literal ladder (ADR 0764 D6)', () => {
  it('resolves exactly the pinned infrastructure/demo ids — no new in-tree workflow', () => {
    const src = readFileSync('src/host/index.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const found = [...src.matchAll(/\bif\s*\(\s*workflowId\s*===\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*))\s*\)/g)]
      .map((m) => m[1] ?? m[2]!)
      .sort();
    // Non-vacuity: the probe must see the ladder it guards.
    expect(found.length).toBeGreaterThanOrEqual(5);
    const added = found.filter((id) => !ALLOWED.includes(id));
    expect(added, 'a new in-tree workflow literal — ship it as a workflow-chain pack instead (ADR 0472)').toEqual([]);
    expect(found).toEqual(ALLOWED.filter((id) => found.includes(id)));
  });

  /**
   * ADR 0775 D6 (`ARWF-1`) — the probe above only matches `if (workflowId ===
   * '…')`, so a by-id FUNCTION lookup was invisible to it: 44 `tmpl.*` and 15
   * `openwop-app.agents.*` in-tree definitions resolve through
   * `getWorkflowTemplate(id)` / `getExampleWorkflow(id)` while this ratchet
   * stayed green. So pin the resolver's RETURN SET instead of one lookup
   * shape: every `return { workflowId, definition: X }`, with where each `X`
   * comes from. A new definition source fails here. P2 converts both modules to
   * a chain pack and deletes them: P2c deleted `getWorkflowTemplate` and dropped
   * it from this set, after all 44 `tmpl.*` moved to the work-twin-templates pack.
   */
  it('pins every definition source the resolver returns (ADR 0775 D6)', () => {
    const src = readFileSync('src/host/index.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const returned = [...src.matchAll(/return\s*\{\s*workflowId\s*,\s*definition:\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((m) => m[1]!);
    // Non-vacuity: the probe must see the resolver it guards.
    expect(returned.length).toBeGreaterThanOrEqual(5);
    const sourceOf = (ident: string): string => {
      const init = new RegExp(`const\\s+${ident}\\s*=\\s*(?:await\\s+)?([\\w$.]+)\\(`).exec(src);
      return init ? `${init[1]}()` : `import:${ident}`;
    };
    expect(returned.map(sourceOf).sort()).toEqual(
      [
        'conformanceFixtures.get()',
        'getChainBackedWorkflow()',
        'getExampleWorkflow()', // ARWF-1 quarantine — P2 deletes it
        'getRegisteredWorkflowAsync()',
        'import:agentMentionWorkflowDefinition',
      ].sort(),
    );
  });

  it('the quarantined in-tree catalogs only shrink (ADR 0775 D6)', () => {
    // ADR 0775 P2a/P2b/P2c took the tmpl.* ceiling 44 → 28 → 12 → 0 and P2c deleted
    // the catalog. It must not come back as an export of that module.
    const templates = readFileSync('src/host/workflowTemplates.ts', 'utf8');
    expect(templates, 'a new tmpl.* ships as a workflow-chain pack').not.toMatch(/\bWORKFLOW_TEMPLATES\b|getWorkflowTemplate|WorkflowDefinition\s*=/);
    expect(EXAMPLE_WORKFLOWS.length, 'a new demo workflow ships as a workflow-chain pack').toBeLessThanOrEqual(15);
  });
});

