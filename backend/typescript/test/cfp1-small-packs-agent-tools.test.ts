/**
 * CFP-1 repair (small packs) — the wrapped read/action tools these features'
 * agent packs now allowlist are REAL: present in `builtinAgentToolIds()` (so the
 * live dispatch lanes can offer them) and honest in their access posture. The
 * `agent-allowlist-resolution` tripwire proves the pack allowlists resolve; this
 * pins the specific tool ids + the read/write posture (goals-tool precedent):
 * read tools FAIL EMPTY without an acting user, the one action tool
 * (comments.post) FAILS TYPED. No app boot: `registerFeatureAgentTool` mutates
 * the shared builtin map, and `executeTool` runs straight off it — the
 * no-acting-user branch short-circuits before any storage read.
 *
 * TST-CCA-1. Red when: the acting-user check is removed from `resolveReadOrgScope`
 * (forms/comments/analytics), from marketplace's or computer-use's own read gate,
 * or from `resolveActionOrgScope` (comments.post); or when `registerFeatureAgentTool`
 * stops writing the builtin map. The read case pins the EXACT note: with the actor
 * check gone, marketplace and computer-use fall through to their feature-toggle
 * gate, which also answers "empty + a note" — only the note text tells the two
 * refusals apart (w67 round 1 caught that wrong-reason pass).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { builtinAgentToolIds, createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { registerFormsAgentTools, FORMS_LIST_FORMS_TOOL_ID, FORMS_LIST_SUBMISSIONS_TOOL_ID } from '../src/features/forms/agentTools.js';
import { registerCommentsAgentTools, COMMENTS_LIST_TOOL_ID, COMMENTS_POST_TOOL_ID } from '../src/features/comments/agentTools.js';
import { registerMarketplaceAgentTools, MARKETPLACE_SEARCH_TOOL_ID } from '../src/features/marketplace/agentTools.js';
import { registerAnalyticsAgentTools, ANALYTICS_QUERY_TOOL_ID } from '../src/features/analytics/agentTools.js';
import { registerComputerUseAgentTools, COMPUTER_USE_STATUS_TOOL_ID } from '../src/features/computer-use/agentTools.js';

const READ_TOOLS = [
  FORMS_LIST_FORMS_TOOL_ID,
  FORMS_LIST_SUBMISSIONS_TOOL_ID,
  COMMENTS_LIST_TOOL_ID,
  MARKETPLACE_SEARCH_TOOL_ID,
  ANALYTICS_QUERY_TOOL_ID,
  COMPUTER_USE_STATUS_TOOL_ID,
];
const ALL_TOOLS = [...READ_TOOLS, COMMENTS_POST_TOOL_ID];

beforeAll(() => {
  registerFormsAgentTools();
  registerCommentsAgentTools();
  registerMarketplaceAgentTools();
  registerAnalyticsAgentTools();
  registerComputerUseAgentTools();
});

describe('CFP-1 small-pack agent tools are registered + honest', () => {
  it('every wrapped tool id is offerable by the live provider', () => {
    const universe = new Set(builtinAgentToolIds());
    for (const id of ALL_TOOLS) expect(universe.has(id), `${id} must be in builtinAgentToolIds()`).toBe(true);
  });

  it('read tools FAIL EMPTY without an acting user (no probe)', async () => {
    const { executeTool } = createAgentToolProvider({ tenantId: 't-cfp1' });
    for (const id of READ_TOOLS) {
      const out = await executeTool({ name: id, input: id === FORMS_LIST_SUBMISSIONS_TOOL_ID ? { formId: 'f1' } : id === COMMENTS_LIST_TOOL_ID ? { resourceType: 'cms_page', resourceId: 'p1' } : {} });
      expect(out.isError, `${id} read must not be a typed error`).toBeFalsy();
      const body = JSON.parse(out.content) as Record<string, unknown>;
      const payload = body.summary ?? body.forms ?? body.submissions ?? body.comments ?? body.listings ?? body.sessions;
      // Either an empty collection or a null summary — never populated data.
      expect(Array.isArray(payload) ? payload.length : payload, `${id} must return empty without an acting user`).toBeFalsy();
      // The ACTOR refusal, not a later gate's (the feature-toggle gate is also "empty + note").
      expect(body.note, `${id} must refuse for the missing acting user`).toBe('This tool only reads from a human-initiated turn.');
    }
  });

  it('comments.post (the one action tool) FAILS TYPED without an acting user', async () => {
    const { executeTool } = createAgentToolProvider({ tenantId: 't-cfp1' });
    const out = await executeTool({ name: COMMENTS_POST_TOOL_ID, input: { resourceType: 'cms_page', resourceId: 'p1', body: 'note' } });
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content) as { error?: string };
    expect(body.error).toBe('acting_user_required');
  });
});
