/**
 * ADR 0488 P6 — the Tutor's read tools.
 *
 * What must hold is ACCESS behaviour, not formatting: a chat tool that reads app
 * state has to fail EMPTY without an acting user and must never widen what that
 * user can see. The house rule (CLAUDE.md § AI↔app exchange) is that such a tool
 * shares its route's access predicate — here both go through the same
 * `tutorialsService` + per-subject `progressStore` the HTTP routes use, so the
 * tests pin the SCOPE rather than re-asserting the service's own behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const registered = vi.hoisted(() => new Map<string, { def: { name: string; description: string; inputSchema: unknown }; run: (i: unknown, s: unknown) => Promise<{ content: string }> }>());
vi.mock('../src/host/agentToolProvider.js', () => ({
  registerFeatureAgentTool: (t: { def: { name: string } }) => { registered.set(t.def.name, t as never); },
}));

const service = vi.hoisted(() => ({ listTutorials: vi.fn(), getTutorial: vi.fn() }));
vi.mock('../src/features/tutorials/tutorialsService.js', () => service);

const store = vi.hoisted(() => ({ listTutorialProgress: vi.fn() }));
vi.mock('../src/features/tutorials/progressStore.js', () => store);

const { registerTutorialsAgentTools, TUTORIALS_CATALOG_TOOL_ID, TUTORIALS_GET_TOOL_ID } =
  await import('../src/features/tutorials/agentTools.js');

const TENANT = 'tenant-1';
const ALICE = 'user:alice';

const TUT = {
  id: 'connect-your-ai', title: 'Connect Your AI', description: 'd', category: 'getting-started',
  hero: { title: 'h', subtitle: 's' }, seedVersion: '1.0.0', source: 'kernel' as const,
  surfaces: ['/keys'],
  phases: [{ number: 1, title: 'P1', chainId: 'tutorial.connect-your-ai.phase-2', steps: [
    { id: '1.1', title: 'Step one', content: [], run: { chainId: 'x' } },
    { id: '1.2', title: 'Step two', content: [] },
  ] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  registered.clear();
  registerTutorialsAgentTools();
  service.listTutorials.mockResolvedValue({ tutorials: [TUT], degraded: false });
  service.getTutorial.mockResolvedValue(TUT);
  store.listTutorialProgress.mockResolvedValue([{ tutorialId: TUT.id, completedStepIds: ['1.1'], updatedAt: 'x' }]);
});

const call = (id: string, input: unknown, scope: unknown) => registered.get(id)!.run(input, scope);

describe('ADR 0488 P6 — registration + honesty of the tool contract', () => {
  it('registers exactly the two READ tools', () => {
    expect([...registered.keys()].sort()).toEqual([TUTORIALS_CATALOG_TOOL_ID, TUTORIALS_GET_TOOL_ID].sort());
  });

  it('both descriptions tell the model it CANNOT launch a walkthrough', () => {
    // The single most likely hallucination is the agent claiming it started a
    // tour. The tool description is where that gets pre-empted.
    for (const id of registered.keys()) {
      expect(registered.get(id)!.def.description.toLowerCase()).toMatch(/cannot (start|launch)|you cannot/);
    }
  });
});

describe('access scoping — fail EMPTY without an acting user', () => {
  it('the catalog returns nothing visible for an unattributed run', async () => {
    const out = JSON.parse((await call(TUTORIALS_CATALOG_TOOL_ID, {}, { tenantId: TENANT })).content);
    expect(out.tutorials).toEqual([]);
    expect(out.note).toMatch(/no acting user/);
    // …and it must not have read anything on that run.
    expect(service.listTutorials).not.toHaveBeenCalled();
  });

  it('the get tool returns null for an unattributed run', async () => {
    const out = JSON.parse((await call(TUTORIALS_GET_TOOL_ID, { tutorialId: TUT.id }, { tenantId: TENANT })).content);
    expect(out.tutorial).toBeNull();
    expect(service.getTutorial).not.toHaveBeenCalled();
  });

  it('progress is read for the CALLER only — never a co-member', async () => {
    await call(TUTORIALS_CATALOG_TOOL_ID, {}, { tenantId: TENANT, actingUserId: ALICE });
    expect(store.listTutorialProgress).toHaveBeenCalledWith(TENANT, ALICE);
  });

  it('every read is scoped to the run tenant', async () => {
    await call(TUTORIALS_GET_TOOL_ID, { tutorialId: TUT.id }, { tenantId: TENANT, actingUserId: ALICE });
    expect(service.getTutorial).toHaveBeenCalledWith(TENANT, TUT.id);
  });
});

describe('answers', () => {
  it('the catalog reports real progress against real totals', async () => {
    const out = JSON.parse((await call(TUTORIALS_CATALOG_TOOL_ID, {}, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.tutorials[0]).toMatchObject({ id: TUT.id, totalSteps: 2, completedSteps: 1, surfaces: ['/keys'] });
  });

  it('a DEGRADED read is disclosed, not passed off as the workspace copy', async () => {
    service.listTutorials.mockResolvedValue({ tutorials: [TUT], degraded: true });
    const out = JSON.parse((await call(TUTORIALS_CATALOG_TOOL_ID, {}, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.note).toMatch(/shipped tutorials/);
  });

  it('get marks completed steps and flags which have a runnable spine', async () => {
    const out = JSON.parse((await call(TUTORIALS_GET_TOOL_ID, { tutorialId: TUT.id }, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.tutorial.phases[0].chainId).toBe('tutorial.connect-your-ai.phase-2');
    expect(out.tutorial.phases[0].steps[0]).toMatchObject({ id: '1.1', completed: true, runnable: true });
    expect(out.tutorial.phases[0].steps[1]).toMatchObject({ id: '1.2', completed: false });
    expect(out.tutorial.phases[0].steps[1].runnable).toBeUndefined();
  });

  it('an unknown id points the model back at the catalog instead of guessing', async () => {
    service.getTutorial.mockResolvedValue(null);
    const out = JSON.parse((await call(TUTORIALS_GET_TOOL_ID, { tutorialId: 'nope' }, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.tutorial).toBeNull();
    expect(out.note).toContain(TUTORIALS_CATALOG_TOOL_ID);
  });

  it('a progress-store failure OMITS progress and says so — never fabricates zero', async () => {
    // TUT2-M1 — this test used to PIN the defect, name included: "degrades to
    // zero progress", asserting `completedSteps === 0`. Zero is a CLAIM about
    // the caller ("you have done nothing"), and the tool's own description
    // declares it authoritative: "it is the only way to know … how far they
    // got". A storage hiccup made the Tutor restart a user who was nearly done.
    store.listTutorialProgress.mockRejectedValue(new Error('store down'));
    const out = JSON.parse((await call(TUTORIALS_CATALOG_TOOL_ID, {}, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.tutorials.length, 'the catalog itself still answers — not a failed turn').toBeGreaterThan(0);
    expect(out.tutorials[0], 'no fabricated zero').not.toHaveProperty('completedSteps');
    expect(out.progressNote, 'and the model is told not to infer one').toMatch(/do not assume zero/i);
  });

  it('the detail tool omits per-step `completed` on the same failure', async () => {
    store.listTutorialProgress.mockRejectedValue(new Error('store down'));
    const out = JSON.parse((await call(TUTORIALS_GET_TOOL_ID, { tutorialId: TUT.id }, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.tutorial, 'the tutorial content still answers').toBeTruthy();
    for (const ph of out.tutorial.phases) for (const st of ph.steps) {
      expect(st, '`completed: false` on every step reads as a fresh start').not.toHaveProperty('completed');
    }
    expect(out.progressNote).toMatch(/do not assume zero/i);
  });

  it('a WORKING progress read still reports real numbers (the negative control)', async () => {
    // Without this, "omit on failure" would be satisfied by a tool that stopped
    // reporting progress entirely.
    const out = JSON.parse((await call(TUTORIALS_CATALOG_TOOL_ID, {}, { tenantId: TENANT, actingUserId: ALICE })).content);
    expect(out.tutorials[0].completedSteps).toBe(1);
    expect(out.progressNote).toBeUndefined();
  });
});
