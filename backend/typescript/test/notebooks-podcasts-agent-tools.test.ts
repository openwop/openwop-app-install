/**
 * CFP-1 remediation — the notebooks Research Analyst + podcasts Producer real
 * chat tools (CHAT-FIRST-PORT-AUDIT #1 / blocker B1).
 *
 * The contract under test: each agent pack's `toolAllowlist` entries now RESOLVE
 * to registered conversational tools (not raw node typeIds silently dropped at
 * dispatch), gated exactly like the feature's HTTP routes — per-tenant toggle,
 * acting user, notebook/org access. Reads fail EMPTY; actions fail TYPED and
 * ignite the real workflow run through the owner. Boots the REAL app (the ADR
 * 0308 D2 registration seam is what's under test).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds, builtinAgentTool } from '../src/host/agentToolProvider.js';
import {
  NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_ASK_TOOL_ID, NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID,
} from '../src/features/notebooks/agentTools.js';
import {
  PODCASTS_LIST_TOOL_ID, PODCASTS_PRODUCE_TOOL_ID,
} from '../src/features/podcasts/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createNotebook, addSource } from '../src/features/notebooks/notebooksService.js';
import { DEFAULT_TOP_K } from '../src/features/kb/kbService.js';
import { createSpeakerProfile, createEpisodeProfile } from '../src/features/podcasts/podcastsService.js';

const TENANT = 'default';
const ORG = 'default';
const USER = 'u-1';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await createOrg({ tenantId: TENANT, createdBy: USER, name: 'Acme', ownerSubject: USER, orgId: ORG });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; conversationId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe('CFP-1 — pack allowlists are exactly the registered tool ids', () => {
  const readPack = (name: string) => JSON.parse(
    readFileSync(new URL(`../../../packs/${name}/pack.json`, import.meta.url), 'utf8'),
  ) as { agents: { toolAllowlist: string[] }[] };

  it('notebooks researcher allowlist = the three registered ids', () => {
    const allow = readPack('feature.notebooks.agents').agents[0]!.toolAllowlist;
    expect([...allow].sort()).toEqual(
      [NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_ASK_TOOL_ID, NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID].sort(),
    );
  });
  it('podcasts producer allowlist = the two registered ids', () => {
    const allow = readPack('feature.podcasts.agents').agents[0]!.toolAllowlist;
    expect([...allow].sort()).toEqual([PODCASTS_LIST_TOOL_ID, PODCASTS_PRODUCE_TOOL_ID].sort());
  });
  /**
   * ADR 0602 — the `topK` DEFAULT a model is told must equal the one retrieval
   * actually applies. Both tools said "default 5" in prose while
   * `kbService.clampTopK` substituted 8: a number the model reasons about when it
   * decides whether to ask for more, hand-copied into a schema description and
   * wrong. CLAUDE.md § "AI↔app information exchange" makes this a non-negotiable —
   * schema text reaching a model is generated from its SSoT or test-pinned to it.
   * The description is now a template literal over `DEFAULT_TOP_K`, so this test
   * pins the JOIN (advertisement ≡ behaviour), not the number.
   */
  it('the advertised topK default equals the retrieval SSoT, and the bound equals the schema', () => {
    const tools = [NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_ASK_TOOL_ID]
      .map((id) => builtinAgentTool(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    // Non-vacuity floor: if the ids stop resolving, the loop below asserts nothing.
    expect(tools.length, 'neither read tool resolved — the assertions below are vacuous').toBe(2);
    for (const tool of tools) {
      const topK = (tool.def.inputSchema as { properties?: Record<string, { description?: string; maximum?: number }> })
        .properties?.topK;
      expect(topK, `${tool.def.name} declares no topK`).toBeDefined();
      expect(topK!.description, `${tool.def.name} advertises a default the retrieval does not use`)
        .toContain(`default ${DEFAULT_TOP_K}`);
      // The prose bound and the schema bound are the same number, from one constant.
      expect(topK!.description).toContain(`max ${topK!.maximum}`);
    }
  });

  it('all five ids register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of [NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_ASK_TOOL_ID, NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID, PODCASTS_LIST_TOOL_ID, PODCASTS_PRODUCE_TOOL_ID]) {
      expect(ids).toContain(id);
    }
  });
});

describe('notebooks read tools fail EMPTY (never success-with-empty as data)', () => {
  it('search: no acting user → empty hits/citations', async () => {
    await setToggle('notebooks', 'on');
    const out = await provider().executeTool({ name: NOTEBOOKS_SEARCH_TOOL_ID, input: { query: 'x', notebookId: 'nb-x' } });
    expect(out.isError).toBeFalsy();
    // NBK2-M1 — this used to pin the UNANNOTATED empty, the exact shape a
    // real no-match search returns. The describe block's own title says
    // "never success-with-empty as data"; without a note it WAS data.
    expect(parse(out.content)).toMatchObject({ hits: [], citations: [] });
    expect(parse(out.content).note, 'the model is told this is not an answer').toMatch(/not a statement|no notebook was/i);
  });
  it('ask: toggle off → empty even with an acting user', async () => {
    await setToggle('notebooks', 'off');
    const out = await provider({ actingUserId: USER }).executeTool({ name: NOTEBOOKS_ASK_TOOL_ID, input: { query: 'x', notebookId: 'nb-x' } });
    // Re-enable BEFORE asserting: this line used to run after the expect, so a
    // failing assertion left the toggle off and cascaded into the next case.
    await setToggle('notebooks', 'on');
    const parsed = parse(out.content);
    expect(parsed).toMatchObject({ augmentedPrompt: '', citations: [], contexts: [] });
    expect(parsed.note, 'NBK2-M1 — an empty augmentedPrompt with no note reads as "the sources say nothing"').toMatch(/not enabled/i);
  });
  it('search: acting user but no access to the notebook → empty (no existence leak)', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({ name: NOTEBOOKS_SEARCH_TOOL_ID, input: { query: 'x', notebookId: 'nb-nonexistent' } });
    const denied = parse(out.content);
    expect(denied).toMatchObject({ hits: [], citations: [] });
    // One note for denied AND missing — the existence non-leak, preserved.
    expect(denied.note).toMatch(/not found or not accessible/i);
  });
});

describe('notebooks write-transformation gates + ignites the real run', () => {
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID, input: { templateId: 'summary', sourceId: 's', notebookId: 'nb' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });
  it('fails closed when the toggle is off', async () => {
    await setToggle('notebooks', 'off');
    const out = await provider({ actingUserId: USER }).executeTool({ name: NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID, input: { templateId: 'summary', sourceId: 's', notebookId: 'nb' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setToggle('notebooks', 'on');
  });
  it('unknown notebook → not_found (shares the route access predicate)', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({ name: NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID, input: { templateId: 'summary', sourceId: 's', notebookId: 'nb-nope' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'not_found' });
  });
  it('grounds (search returns the source), then authors: starts the transform run', async () => {
    await setToggle('notebooks', 'on');
    const nb = await createNotebook(TENANT, ORG, USER, { name: 'Repair NB' });
    const source = await addSource(TENANT, nb.id, USER, { title: 'Paper', text: 'Transformers scale with data and compute across many tasks.' });
    const p = provider({ actingUserId: USER });

    const search = parse((await p.executeTool({ name: NOTEBOOKS_SEARCH_TOOL_ID, input: { query: 'transformers', notebookId: nb.id } })).content);
    expect(Array.isArray(search.hits)).toBe(true);

    const out = await p.executeTool({ name: NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID, input: { templateId: 'summary', sourceId: source.documentId, notebookId: nb.id } });
    expect(out.isError).toBeFalsy();
    const res = parse(out.content);
    expect(typeof res.runId).toBe('string');
    expect(res).toMatchObject({ templateId: 'summary', sourceId: source.documentId });

    const bad = await p.executeTool({ name: NOTEBOOKS_WRITE_TRANSFORMATION_TOOL_ID, input: { templateId: 'not-a-template', sourceId: source.documentId, notebookId: nb.id } });
    expect(bad.isError).toBe(true);
    expect(parse(bad.content)).toMatchObject({ error: 'validation_error' });
  });

  /**
   * ADR 0602 § Correction log, item D (`M5`). These two tools kept hand-written
   * copies of the count rule that had already diverged from the shared helper
   * (no `Number.isFinite`), in the MODEL-FACING lane. Both now go through
   * `surfaceOptCount`, and a present-but-unusable `topK` is REPORTED to the
   * model as a typed tool error rather than silently becoming the host default —
   * a wrong-sized grounded context is exactly the success-with-wrong this ADR
   * is about, and the model can repair from an error it can read.
   */
  it('an unusable topK is a typed tool error on BOTH read tools, and an absent one is not (M5)', async () => {
    await setToggle('notebooks', 'on');
    const nb = await createNotebook(TENANT, ORG, USER, { name: 'TopK NB' });
    await addSource(TENANT, nb.id, USER, { title: 'Paper', text: 'Transformers scale with data and compute.' });
    const p = provider({ actingUserId: USER });

    for (const name of [NOTEBOOKS_SEARCH_TOOL_ID, NOTEBOOKS_ASK_TOOL_ID]) {
      for (const topK of ['5', 0.5, Number.POSITIVE_INFINITY]) {
        const out = await p.executeTool({ name, input: { query: 'transformers', notebookId: nb.id, topK } });
        expect(out.isError, `${name} accepted topK=${String(topK)}`).toBe(true);
        expect(parse(out.content)).toMatchObject({ error: 'validation_error' });
      }
      // The control: without this, a tool that errored on EVERYTHING would pass
      // the three assertions above. Absent still means "the callee's default".
      const ok = await p.executeTool({ name, input: { query: 'transformers', notebookId: nb.id } });
      expect(ok.isError, `${name} rejected an absent topK`).toBeFalsy();
      // And a legal count is still a success, so the guard is not simply "reject
      // anything present".
      const bounded = await p.executeTool({ name, input: { query: 'transformers', notebookId: nb.id, topK: 1 } });
      expect(bounded.isError, `${name} rejected topK=1`).toBeFalsy();
    }
  });
});

describe('podcasts.list read tool', () => {
  it('no acting user → empty collections', async () => {
    await setToggle('podcasts', 'on');
    const out = await provider().executeTool({ name: PODCASTS_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content)).toEqual({ episodeProfiles: [], speakerProfiles: [], shows: [], episodes: [] });
  });
  it('acting user + access → the org building blocks', async () => {
    await createSpeakerProfile(TENANT, ORG, { name: 'Duo', speakers: [{ name: 'A', voiceId: 'v1' }, { name: 'B', voiceId: 'v2' }] });
    const out = await provider({ actingUserId: USER }).executeTool({ name: PODCASTS_LIST_TOOL_ID, input: { orgId: ORG } });
    const res = parse(out.content) as { speakerProfiles: unknown[] };
    expect(res.speakerProfiles.length).toBeGreaterThanOrEqual(1);
  });
});

describe('podcasts.produce gates + ignites the real generation run', () => {
  it('fails closed when the toggle is off', async () => {
    await setToggle('podcasts', 'off');
    const out = await provider({ actingUserId: USER }).executeTool({ name: PODCASTS_PRODUCE_TOOL_ID, input: { notebookId: 'nb', episodeProfileId: 'ep' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setToggle('podcasts', 'on');
  });
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: PODCASTS_PRODUCE_TOOL_ID, input: { notebookId: 'nb', episodeProfileId: 'ep' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });
  it('unknown episode profile → validation_error', async () => {
    const out = await provider({ actingUserId: USER }).executeTool({ name: PODCASTS_PRODUCE_TOOL_ID, input: { notebookId: 'nb', episodeProfileId: 'ep-nope', orgId: ORG } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'validation_error' });
  });
  it('produces from a real notebook + episode profile: starts podcasts.generate', async () => {
    await setToggle('notebooks', 'on');
    await setToggle('podcasts', 'on');
    const nb = await createNotebook(TENANT, ORG, USER, { name: 'Pod NB' });
    const cast = await createSpeakerProfile(TENANT, ORG, { name: 'Solo', speakers: [{ name: 'Host', voiceId: 'v1' }] });
    const ep = await createEpisodeProfile(TENANT, ORG, { name: 'Weekly', speakerProfileId: cast.id, segmentCount: 3 });
    const out = await provider({ actingUserId: USER }).executeTool({
      name: PODCASTS_PRODUCE_TOOL_ID,
      input: { notebookId: nb.id, episodeProfileId: ep.id, title: 'Ep 1', orgId: ORG },
    });
    expect(out.isError).toBeFalsy();
    const res = parse(out.content);
    expect(typeof res.episodeId).toBe('string');
    expect(typeof res.runId).toBe('string');
    expect(res.status).toBe('queued');
  });
  it('a duplicate produce inside the window reuses the run — no second run, no orphan episode (HIGH-1)', async () => {
    await setToggle('notebooks', 'on');
    await setToggle('podcasts', 'on');
    const nb = await createNotebook(TENANT, ORG, USER, { name: 'Pod NB dup' });
    const cast = await createSpeakerProfile(TENANT, ORG, { name: 'Solo', speakers: [{ name: 'Host', voiceId: 'v1' }] });
    const ep = await createEpisodeProfile(TENANT, ORG, { name: 'Weekly', speakerProfileId: cast.id, segmentCount: 3 });
    const p = provider({ actingUserId: USER });
    const input = { notebookId: nb.id, episodeProfileId: ep.id, orgId: ORG };
    const first = parse((await p.executeTool({ name: PODCASTS_PRODUCE_TOOL_ID, input })).content);
    expect(typeof first.runId).toBe('string');
    const before = parse((await p.executeTool({ name: PODCASTS_LIST_TOOL_ID, input: { orgId: ORG } })).content);
    // an identical call moments later → REUSE, not a second ignition.
    const dup = parse((await p.executeTool({ name: PODCASTS_PRODUCE_TOOL_ID, input })).content);
    expect(dup.ignited).toBe(false);
    expect(dup.runId).toBe(first.runId);
    // and no orphan episode row was minted (createEpisode is behind the claim).
    const after = parse((await p.executeTool({ name: PODCASTS_LIST_TOOL_ID, input: { orgId: ORG } })).content);
    expect((after.episodes as unknown[]).length).toBe((before.episodes as unknown[]).length);
  });
});
