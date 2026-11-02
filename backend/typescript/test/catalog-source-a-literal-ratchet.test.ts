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
 * This pins the set. Shrink-only: removing an entry is fine, but the list must
 * be updated in the same change (the check is two-sided, so a stale ALLOWED
 * entry fails too); adding one fails here. A new workflow ships as a chain pack
 * (CLAUDE.md "Workflows — never hard-code").
 *
 * grade-tests w67 (TST-CBM-1): red when a new `if (workflowId === …)` literal
 * appears, when a pinned literal disappears without its ALLOWED entry going
 * with it, when the resolver gains a new definition source, or when the deleted
 * template catalog / demo-workflow resolver comes back in code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/stripComments.js';

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
    const src = stripComments(readFileSync('src/host/index.ts', 'utf8'));
    const found = [...src.matchAll(/\bif\s*\(\s*workflowId\s*===\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*))\s*\)/g)]
      .map((m) => m[1] ?? m[2]!)
      .sort();
    const added = found.filter((id) => !ALLOWED.includes(id));
    expect(added, 'a new in-tree workflow literal — ship it as a workflow-chain pack instead (ADR 0472)').toEqual([]);
    // Two-sided: a literal that left the ladder must leave ALLOWED in the same
    // change, or the list keeps permitting an id nothing resolves any more.
    expect(found, 'an ALLOWED id no longer resolves here — remove it from ALLOWED').toEqual(ALLOWED);
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
   * P2d deleted `getExampleWorkflow` (the 15 `openwop-app.agents.*` had zero prod
   * runs, so they were deleted rather than archived) and dropped it too.
   */
  it('pins every definition source the resolver returns (ADR 0775 D6)', () => {
    const src = stripComments(readFileSync('src/host/index.ts', 'utf8'));
    const returned = [...src.matchAll(/return\s*\{\s*workflowId\s*,\s*definition:\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((m) => m[1]!);
    // Non-vacuity: the probe must see the resolver it guards.
    expect(returned.length).toBeGreaterThanOrEqual(4); // 5 → 4 when P2d removed getExampleWorkflow
    const sourceOf = (ident: string): string => {
      const init = new RegExp(`const\\s+${ident}\\s*=\\s*(?:await\\s+)?([\\w$.]+)\\(`).exec(src);
      return init ? `${init[1]}()` : `import:${ident}`;
    };
    expect(returned.map(sourceOf).sort()).toEqual(
      [
        'conformanceFixtures.get()',
        'getChainBackedWorkflow()',
        'getRegisteredWorkflowAsync()',
        'import:agentMentionWorkflowDefinition',
      ].sort(),
    );
  });

  it('the quarantined in-tree catalogs only shrink (ADR 0775 D6)', () => {
    // ADR 0775 P2a/P2b/P2c took the tmpl.* ceiling 44 → 28 → 12 → 0 and P2c deleted
    // the catalog. It must not come back as an export of that module. P2d took the
    // openwop-app.agents.* ceiling 15 → 0 and deleted that module outright.
    const templates = stripComments(readFileSync('src/host/workflowTemplates.ts', 'utf8'));
    expect(templates, 'a new tmpl.* ships as a workflow-chain pack').not.toMatch(/\bWORKFLOW_TEMPLATES\b|getWorkflowTemplate|WorkflowDefinition\s*=/);
    expect(existsSync('src/host/exampleWorkflows.ts'), 'a new demo workflow ships as a workflow-chain pack').toBe(false);
    const index = stripComments(readFileSync('src/host/index.ts', 'utf8'));
    expect(index, 'the deleted demo-workflow resolver must not return to catalog source A').not.toMatch(/getExampleWorkflow|exampleWorkflows\.js/);
  });
});

