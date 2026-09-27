/**
 * ADR 0368 P6c + P3 (#1875 / #1885) — Enrich-with-AI reachability, END-TO-END
 * without a live model. Closes the architect's falsifiability check for the
 * grant: an agent that never declared the Tour Author tool still
 *   (1) gets `openwop:walkthroughs.register-draft` via the REAL effectiveToolAllowlist
 *       resolver (the baseline union — the #1885 grant), and
 *   (2) has it resolvable + in the OFFERED set built the way dispatch builds it,
 *       and
 *   (3) when a model emits a call to it, the SHARED tool loop EXECUTES it (not
 *       §A14-forbidden, not interrupt_not_found) and a transient tour draft
 *       lands in the catalog.
 *
 * This is the integration wiring proof — it deliberately does NOT re-test the
 * units already covered: `tour-author-tool.test.ts` (the tool's `run` synthesis)
 * and the two allowlist guardrail tests (which pin the CONSTANT
 * `DEFAULT_ON_AGENT_TOOL_IDS`, not the resolver's output for an agent).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { registerWalkthroughAuthorTool, WALKTHROUGH_REGISTER_DRAFT_TOOL_ID } from '../src/features/walkthroughs/walkthroughAuthorTool.js';
import { registerWalkthroughNodes } from '../src/features/walkthroughs/walkthroughNodes.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { effectiveToolAllowlist } from '../src/host/agentToolAllowlistService.js';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import { listRegisteredWorkflows, deleteRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { removeOwnership } from '../src/host/workflowOwnership.js';
import type { AiToolCallResult, AiToolCallRequest } from '../src/executor/types.js';

const TENANT = 'org:tour-reach';
// An agent whose manifest declares ONLY its own domain tool — never the Tour
// Author tool. The grant must reach it anyway (that is the whole point of #1885).
const NON_TOUR_MANIFEST = ['openwop:crm.contacts.read'];
const registered: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  ensureNodesRegistered();
  registerWalkthroughNodes(); // the ui.tour.* node types must exist for DAG validation
  createHostAdapterSuite({ storage });
  registerWalkthroughAuthorTool();
});
afterEach(async () => { for (const id of registered.splice(0)) { deleteRegisteredWorkflow(id); await removeOwnership(TENANT, id); } });

describe('Enrich-with-AI reachability — the ADR 0368 P3 grant, end-to-end (no live model)', () => {
  it('the real allowlist resolver grants tours.register-draft to an agent that never declared it', () => {
    const resolved = effectiveToolAllowlist(NON_TOUR_MANIFEST, undefined);
    // Not just present in the constant — present in the RESOLVER OUTPUT for this
    // agent (manifest ∪ baseline). This is what dispatch offers the model.
    expect(resolved).toContain(WALKTHROUGH_REGISTER_DRAFT_TOOL_ID);
    expect(resolved).toContain('openwop:crm.contacts.read'); // the manifest tool is preserved too
  });

  it('the real provider offers + executes it through the shared loop → a transient tour draft is registered', async () => {
    const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'agent-generic' });
    // Compile the OFFERED tools exactly as dispatch does: the resolved allowlist
    // ∩ the registered tools. If the grant works, the tour tool is in this array.
    const tools: CompiledTool[] = effectiveToolAllowlist(NON_TOUR_MANIFEST, undefined)
      .map((id) => provider.resolveTool(id))
      .filter((def): def is NonNullable<typeof def> => Boolean(def))
      .map((def) => ({ def, validate: () => ({ ok: true as const }) }));
    expect(tools.some((t) => t.def.name === WALKTHROUGH_REGISTER_DRAFT_TOOL_ID), 'the tool must be OFFERED').toBe(true);

    const before = listRegisteredWorkflows({ includeTransient: true, includeArchived: true }).length;

    // Script the model: round 1 emits the register-draft call with enriched
    // steps (as the Enrich composer prompt drives it to); round 2 finalizes.
    const callAIWithTools = vi.fn<(req: AiToolCallRequest) => Promise<AiToolCallResult>>()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: WALKTHROUGH_REGISTER_DRAFT_TOOL_ID, input: {
        name: 'Recorded Flow',
        steps: [
          { actionId: 'campaign-studio.new-brief.click', narration: 'Open a new brief.' },
          { checkpoint: 'campaign-studio.brief-exists', narration: 'Confirm it was created.' },
        ],
      } }] })
      .mockResolvedValueOnce({ content: 'Your tour draft is ready to review.', toolCalls: [] });

    const res = await runChatToolLoop(
      { provider: 'anthropic', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'Turn my recording into a polished tour.' }],
        tools, agentId: 'agent-generic', persona: 'Assistant' },
      { callAIWithTools, executeTool: provider.executeTool },
    );

    // Executed — NOT §A14-forbidden, NOT surfaced as an error/interrupt.
    expect(res.error).toBeUndefined();
    expect(res.finalText).toContain('ready to review');
    const ret = res.events.find((e) => e.type === 'agent.toolReturned' && e.toolName === WALKTHROUGH_REGISTER_DRAFT_TOOL_ID);
    expect(ret, 'the tour tool must have been executed').toBeTruthy();
    expect((ret as { status?: string }).status).toBe('ok');

    // The register-draft EFFECT: exactly one new transient tour draft in the catalog.
    const after = listRegisteredWorkflows({ includeTransient: true, includeArchived: true });
    expect(after.length).toBe(before + 1);
    const draft = after.find((d) =>
      (d.metadata as { lifecycle?: { transient?: boolean } }).lifecycle?.transient === true
      && (d.metadata as { walkthrough?: boolean }).walkthrough === true);
    expect(draft, 'a transient tour draft must be registered').toBeTruthy();
    registered.push(draft!.workflowId);
    expect(draft!.nodes.map((n) => n.typeId)).toEqual(['ui.walkthrough.step', 'ui.walkthrough.checkpoint']);
  });
});
