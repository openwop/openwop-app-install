/**
 * ADR 0368 Phase 6c — the Tour Author register tool: enriched steps →
 * transient ui.walkthrough.step/checkpoint DAG (ADR 0376 renamed ui.tour.*);
 * validates; catalog-hidden; a bad step errors and registers nothing; each
 * refusal is asserted by its OWN message (an empty step list is also refused
 * later by DAG validation, so `isError` alone could not tell the two apart —
 * round-1 probe 8fw4g1-wa-empty).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { registerWalkthroughAuthorTool, WALKTHROUGH_REGISTER_DRAFT_TOOL_ID } from '../src/features/walkthroughs/walkthroughAuthorTool.js';
import { registerWalkthroughNodes } from '../src/features/walkthroughs/walkthroughNodes.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { getRegisteredWorkflow, deleteRegisteredWorkflow, listRegisteredWorkflows } from '../src/host/workflowsRegistry.js';
import { removeOwnership } from '../src/host/workflowOwnership.js';

const TENANT = 'org:tour-author';
let runTool: (input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
const registered: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  ensureNodesRegistered();
  registerWalkthroughNodes(); // the ui.walkthrough.* node types must exist for validation
  createHostAdapterSuite({ storage });
  registerWalkthroughAuthorTool();
  const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'agent-tour' });
  runTool = (input) => provider.executeTool({ name: WALKTHROUGH_REGISTER_DRAFT_TOOL_ID, input });
});
afterEach(async () => { for (const id of registered.splice(0)) { deleteRegisteredWorkflow(id); await removeOwnership(TENANT, id); } });

const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe('walkthroughs.register-draft (ADR 0368 P6c)', () => {
  it('enriched steps → a transient, catalog-hidden ui.walkthrough.step/checkpoint DAG', async () => {
    const r = await runTool({
      name: 'Polished Flow',
      steps: [
        { actionId: 'campaign-studio.new-brief.click', narration: 'Open a new brief.' },
        { actionId: 'campaign-studio.brief-name.fill', narration: 'Name it.', hitl: true },
        { checkpoint: 'campaign-studio.brief-exists', narration: 'Confirm it was created.' },
      ],
    });
    expect(r.isError, r.content).toBeUndefined();
    const body = parse(r);
    const id = body.workflowId as string;
    registered.push(id);
    expect(body.stepCount).toBe(3);

    // Transient ⇒ catalog-hidden but resolvable.
    expect(listRegisteredWorkflows().some((d) => d.workflowId === id)).toBe(false);
    const def = getRegisteredWorkflow(id)!;
    expect((def.metadata as { lifecycle?: { transient?: boolean; generatedBy?: string } }).lifecycle)
      .toEqual({ transient: true, generatedBy: 'agent:agent-tour' });
    expect(def.nodes.map((n) => n.typeId)).toEqual(['ui.walkthrough.step', 'ui.walkthrough.step', 'ui.walkthrough.checkpoint']);
    expect((def.nodes[1]!.config as { hitl?: boolean }).hitl).toBe(true);
    expect((def.nodes[2]!.config as { expect?: string }).expect).toBe('campaign-studio.brief-exists');
    // The DAG is the ordered chain s1 → s2 → s3.
    expect(def.edges?.map((e) => [e.sourceNodeId, e.targetNodeId])).toEqual([['s1', 's2'], ['s2', 's3']]);
  });

  it('a step missing both actionId and checkpoint errors and registers nothing', async () => {
    const before = listRegisteredWorkflows({ includeTransient: true, includeArchived: true }).length;
    const r = await runTool({ name: 'Bad', steps: [{ narration: 'nope' }] });
    expect(r.isError).toBe(true);
    expect(parse(r).message).toContain('actionId or a checkpoint');
    expect(listRegisteredWorkflows({ includeTransient: true, includeArchived: true }).length).toBe(before);
  });

  it('empty steps / missing name are rejected', async () => {
    const empty = await runTool({ name: 'X', steps: [] });
    expect(empty.isError).toBe(true);
    expect(parse(empty).message).toBe('steps must be a non-empty array.');
    const nameless = await runTool({ steps: [{ actionId: 'a.b.c' }] });
    expect(nameless.isError).toBe(true);
    expect(parse(nameless).message).toBe('name is required.');
  });
});
