/**
 * ADR 0596 (`WFAC-3`) — prompt↔catalog parity for the AI Workflow Author lane.
 *
 * The CLAUDE.md non-negotiables this pins, per the feature's own exchange lane:
 *   1. Schema-carrying tool output is NEVER compacted. The `draft` tool returns
 *      the closed-world node catalog WITH each node's JSON Schemas; a compacted
 *      enum or an elided node array makes the model author against a catalog
 *      that is not this host's.
 *   2. Schema/tool text reaching a model is GENERATED from its SSoT or
 *      TEST-PINNED to it. Two hand-copies live in this feature by construction —
 *      the pack `.mjs` cannot import TypeScript, so its system prompt restates
 *      rules the host enforces in `.ts`. Those restatements are pinned here.
 *   3. A rule stated to the model as a MUST is a rule the host ENFORCES. The
 *      acyclicity claim is the one that was false for the life of the feature
 *      (`WFAWF-9`): the prompt said the graph MUST be acyclic and nothing
 *      checked it. These assertions fail if either half moves without the other.
 *
 * Sabotage-witnessed (grade-tests w18, probes `w18g1-pc-*`): dropping the draft
 * id from SCHEMA_READ_EXEMPT_TOOLS, renaming a prompt tool bullet or a pack
 * handler key, removing the cycle check or the closed-world check, rejecting a
 * disconnected graph, writing "connected" into any of the three sources,
 * re-wording the persist description as an auto-open, blanking the catalog's
 * description hop or the menu's description field, feeding the menu something
 * other than the live catalog, or hand-copying the clearFields enum — each turns
 * a case red. CEILING: the `index.mjs` / `agentTools.ts` wiring pins at the
 * bottom are source pins (the pack cannot import TypeScript), so they police a
 * SPELLING; the behavioral cases above them carry the claims a pin cannot.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WORKFLOW_AUTHOR_DRAFT_TOOL_ID,
  WORKFLOW_AUTHOR_GET_TOOL_ID,
  WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
  WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
} from '../agentTools.js';
import { validateAuthoredWorkflow } from '../workflowAuthorService.js';
import { ensureNodesRegistered } from '../../../bootstrap/nodes.js';
import { buildNodeCatalog } from '../../../host/nodeCatalogBuilder.js';
import type { ToolResultTransformContext } from '../../../host/toolResultTransform.js';

/** The pack module, typed for the two exports these parity cases execute. */
type NodesPack = { nodes: Record<string, unknown>; buildSystemPrompt: (c: { nodes: unknown[] }) => string };
const loadPack = async (): Promise<NodesPack> =>
  (await import(join(REPO_ROOT, 'packs/feature.workflow-author.nodes/index.mjs'))) as NodesPack;

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '../../../../../..');
const packSrc = readFileSync(join(REPO_ROOT, 'packs/feature.workflow-author.nodes/index.mjs'), 'utf8');
const architectPrompt = readFileSync(
  join(REPO_ROOT, 'packs/vendor.openwop-app.workflow-author.agents/prompts/workflow-architect.md'),
  'utf8',
);
const agentToolsSrc = readFileSync(join(here, '..', 'agentTools.ts'), 'utf8');
const PACKS_DIR = join(REPO_ROOT, 'packs');
const nodesManifest = JSON.parse(
  readFileSync(join(PACKS_DIR, 'feature.workflow-author.nodes/pack.json'), 'utf8'),
) as { description: string; nodes: Array<{ typeId: string; description: string }> };
const agentsManifest = JSON.parse(
  readFileSync(join(PACKS_DIR, 'vendor.openwop-app.workflow-author.agents/pack.json'), 'utf8'),
) as { description: string; agents: Array<{ agentId: string; description: string }> };

/** The THREE sources this feature puts in front of a model. `agentTools.ts` is
 *  the one the old connectivity assertion loaded and never checked. */
const MODEL_FACING_SOURCES: Array<[string, string]> = [
  // Comments are stripped from the CODE sources only: a comment that QUOTES the
  // retired wording (to explain why it is gone) is not the model reading it, and
  // counting comments is a known false-positive family for this repo's ratchets.
  // The prompt is markdown — every byte of it reaches the model, so nothing is
  // stripped there.
  ['pack system prompt (index.mjs)', stripComments(packSrc)],
  ['agent system prompt (workflow-architect.md)', architectPrompt],
  ['chat tool descriptions (agentTools.ts)', stripComments(agentToolsSrc)],
];

/** The ONE honest way to mention connectivity: as the preference it is. */
const ALLOWED_CONNECTIVITY_PHRASE = /a\s+single\s+connected\s+graph/gi;

/** Strip comments before a negative prose assertion. A comment that QUOTES the
 *  retired wording (to explain why it is gone) is not the model reading it —
 *  counting comments is a known false-positive family for this repo's ratchets. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/** Every prose string the two pack manifests PUBLISH — each one reaches a model
 *  (node `description` → `buildNodeCatalog` → `buildAuthoringCatalog` → the pack's
 *  `buildSystemPrompt` menu) or a human (the palette tooltip, the packs admin
 *  page, `GET /v1/agents`). This is the population, enumerated from the manifests
 *  themselves rather than from a hand-written list, so a NEW node or agent is
 *  covered the moment it is declared. */
const MANIFEST_PROSE: Array<[string, string]> = [
  ['nodes pack description', nodesManifest.description],
  ...nodesManifest.nodes.map((n) => [`node ${n.typeId}`, n.description] as [string, string]),
  ['agents pack description', agentsManifest.description],
  ...agentsManifest.agents.map((a) => [`agent ${a.agentId}`, a.description] as [string, string]),
];

describe('WFAC-3 — the catalog tool is exempt from tool-result compaction', () => {
  it('the draft (catalog) tool is in SCHEMA_READ_EXEMPT_TOOLS, by its exported constant', async () => {
    const { SCHEMA_READ_EXEMPT_TOOLS } = await import('../../../host/toolResultTransform.js');
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain(WORKFLOW_AUTHOR_DRAFT_TOOL_ID);
  });

  it('its exact sibling app-builder.catalog is exempt too — this is one class, not a special case', async () => {
    const { SCHEMA_READ_EXEMPT_TOOLS } = await import('../../../host/toolResultTransform.js');
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain('openwop:app-builder.catalog');
  });

  it('the compaction transform actually leaves the catalog byte-exact', async () => {
    const { applyToolResultTransform, registerToolResultTransform, __resetToolResultTransform } =
      await import('../../../host/toolResultTransform.js');
    // A transform that destroys everything: if the exemption is not honoured for
    // this tool id, the assertion below cannot pass by accident.
    registerToolResultTransform(() => 'COMPACTED');
    try {
      const content = JSON.stringify({ nodes: [{ typeId: 'core.noop', configSchema: { enum: ['a', 'b'] } }] });
      const ctx: ToolResultTransformContext = { toolName: WORKFLOW_AUTHOR_DRAFT_TOOL_ID, decision: { mode: 'lossy' } };
      expect(applyToolResultTransform(content, ctx)).toBe(content);
      // control: a non-exempt tool IS transformed, so the exemption is what did it
      expect(applyToolResultTransform(content, { ...ctx, toolName: 'openwop:some.other.tool' }))
        .toBe('COMPACTED');
    } finally {
      __resetToolResultTransform();
    }
  });
});

describe('WFAC-3 — the four tool ids the model is told about are the four that exist', () => {
  it('the agent prompt names exactly the exported tool constants', () => {
    // The prompt writes the bare node names; the pack manifest + allowlist carry
    // the `openwop:`-prefixed ids. Pin the SUFFIXES so a renamed tool breaks here
    // (the repo-wide `agent-prompt-tool-ids.test.ts` pins the prefixed form).
    for (const id of [
      WORKFLOW_AUTHOR_DRAFT_TOOL_ID,
      WORKFLOW_AUTHOR_GET_TOOL_ID,
      WORKFLOW_AUTHOR_VALIDATE_TOOL_ID,
      WORKFLOW_AUTHOR_PERSIST_TOOL_ID,
    ]) {
      const bare = id.split('.').pop()!;
      expect(architectPrompt, id).toContain(`**${bare}**`);
    }
  });

  it('the pack exports exactly those four node handlers', async () => {
    // Executed, not grepped: the pack's handler keys ARE the chat tool constants
    // minus the `openwop:` prefix (the node-pack test pins literals; this pins
    // the constants the chat lane registers under).
    const pack = await loadPack();
    expect(Object.keys(pack.nodes).sort()).toEqual(
      [WORKFLOW_AUTHOR_DRAFT_TOOL_ID, WORKFLOW_AUTHOR_GET_TOOL_ID, WORKFLOW_AUTHOR_VALIDATE_TOOL_ID, WORKFLOW_AUTHOR_PERSIST_TOOL_ID]
        .map((id) => id.replace('openwop:', ''))
        .sort(),
    );
  });
});

describe('WFAC-3 / WFAWF-9 — a rule stated to the model is a rule the host enforces', () => {
  it('the pack system prompt states acyclicity as a MUST, and the host refuses a cycle', () => {
    expect(packSrc).toMatch(/MUST be ACYCLIC/);
    ensureNodesRegistered();
    const v = validateAuthoredWorkflow({
      workflowId: 'parity.cyclic',
      nodes: [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'a' },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/cycle/i);
  });

  it('the agent prompt states the same rule, and names it as enforced by BOTH doors', () => {
    expect(architectPrompt).toMatch(/MUST be acyclic/);
    expect(architectPrompt).toMatch(/`validate`[\s\S]{0,40}`persist`/);
  });

  it('CONNECTIVITY is NOT enforced — a disconnected graph is ACCEPTED', () => {
    // The inverse of the acyclicity pin, and the one that shipped as a lie.
    // A disconnected graph runs fine (two components both execute), so promising
    // the model it is rejected would be the same defect with the polarity flipped.
    ensureNodesRegistered();
    const v = validateAuthoredWorkflow({
      workflowId: 'parity.islands',
      nodes: [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }],
    });
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });

  // ADR 0596 §Correction 9 — this assertion used to be titled "…anywhere the
  // model reads" while checking only TWO of the three sources, and it policed two
  // exact spellings (`/MUST be connected|Keep the graph connected/`). The third
  // source — `agentTools.ts`, the chat lane's own tool descriptions — was loaded
  // at the top of this file and never checked, and it still said "compose a
  // connected, acyclic node/edge graph". A ratchet that names a scope it does not
  // cover is worse than no ratchet: it is a green light over an unread surface.
  it.each(MODEL_FACING_SOURCES)(
    '%s never states connectivity as a requirement (any spelling)',
    (_label, src) => {
      // The CORRECTED phrasing legitimately contains the word.
      const prose = src.replace(ALLOWED_CONNECTIVITY_PHRASE, '');
      // `\bconnected\b` does not match "disconnected" — no word boundary there —
      // which is exactly the distinction that makes the honest sentence sayable.
      expect(prose).not.toMatch(/\bconnected\b/i);
    },
  );

  it('…and each of those three sources still says the PREFERENCE, so the model is not left guessing', () => {
    for (const [label, src] of MODEL_FACING_SOURCES) {
      expect(src, label).toMatch(ALLOWED_CONNECTIVITY_PHRASE);
    }
  });

  it('the closed-world rule the prompt states is the check the service runs', () => {
    expect(packSrc).toMatch(/CLOSED-WORLD: every node\.typeId MUST be one of the catalog typeIds/);
    ensureNodesRegistered();
    const v = validateAuthoredWorkflow({
      workflowId: 'parity.unknown',
      nodes: [{ nodeId: 'a', typeId: 'not.a.real.node' }],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/Unknown node typeId/);
  });
});

describe('WFAU-1 — the retired "it opens in the builder" promise is gone from every source that restates persist', () => {
  // The claim the PRODUCT makes about itself, in the FINITE voice that asserts
  // it already happened ("so it opens in the builder", "it is open in the
  // builder"). The two lookbehinds are what separate the lie from the truth the
  // fix ships: "ready TO OPEN on the canvas" and "can BE opened in the builder"
  // are both accurate and must stay sayable. Manifest prose has no
  // human-as-subject sentences (unlike the architect prompt, where "they'll open
  // it in the builder" is TRUE), so the broad form is the strict one here.
  const CLAIMS_AUTO_OPEN = /(?<!to )(?<!be )\bopens?\s+(?:it\s+)?(?:in|on)\s+the\s+(?:builder|canvas)/i;

  it.each(MANIFEST_PROSE)('%s does not claim the authored workflow opens itself', (_label, text) => {
    expect(text).not.toMatch(CLAIMS_AUTO_OPEN);
  });

  it('the persist NODE description states the hand-off truthfully instead of retiring into silence', () => {
    const persist = nodesManifest.nodes.find((n) => n.typeId === 'feature.workflow-author.nodes.persist');
    expect(persist, 'the persist node must still be declared').toBeDefined();
    expect(persist!.description).toMatch(/READY TO OPEN/i);
    expect(persist!.description).toMatch(/nothing navigates/i);
  });

  it('that description IS model-facing: it survives the catalog hop the pack menu is built from', () => {
    // The call graph HIGH-1 named, executed rather than grepped:
    //   pack.json → buildNodeCatalog → buildAuthoringCatalog → buildSystemPrompt.
    // `resolveDefaultPackDir()` reads OPENWOP_PACK_DIR at call time, so pointing
    // it at the repo's own packs/ makes this the REAL manifest. Restored in
    // `finally` — `test/setup/isolatePackDir.ts` fails the file that leaks it.
    const prev = process.env.OPENWOP_PACK_DIR;
    process.env.OPENWOP_PACK_DIR = PACKS_DIR;
    try {
      const persistInCatalog = buildNodeCatalog()
        .find((n) => n.typeId === 'feature.workflow-author.nodes.persist');
      expect(persistInCatalog, 'persist must be resolvable from the repo pack tree').toBeDefined();
      // `buildSystemPrompt` stringifies exactly this field into the menu.
      expect(persistInCatalog!.description).toBe(
        nodesManifest.nodes.find((n) => n.typeId === 'feature.workflow-author.nodes.persist')!.description,
      );
      expect(persistInCatalog!.description).not.toMatch(CLAIMS_AUTO_OPEN);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_PACK_DIR;
      else process.env.OPENWOP_PACK_DIR = prev;
    }
  });

  it('the pack menu really carries `description` — the last hop into the system prompt', async () => {
    // Executed: the menu is the prompt's last line, as JSON.
    const { buildSystemPrompt } = await loadPack();
    const prompt = buildSystemPrompt({ nodes: [{ typeId: 'x.t', label: 'L', description: 'DESC-MARKER-0596', category: 'flow' }] });
    const menu = JSON.parse(prompt.trim().split('\n').pop() as string) as Array<{ typeId: string; description?: string }>;
    expect(menu.find((n) => n.typeId === 'x.t')?.description).toBe('DESC-MARKER-0596');
  });
});

describe('WFAC-3 — the catalog the model sees is the LIVE one, never a hand-copy', () => {
  it('the pack builds its menu from the host surface, not an in-file node list', async () => {
    // Executed through the draft handler: the system prompt sent to the model
    // carries the node the SURFACE returned. The old `toContain('buildSystemPrompt(catalog)')`
    // also matched the function's own signature, so it could not fail (w18
    // probe pc-livecat was vacuous).
    const pack = await loadPack();
    const draft = pack.nodes['feature.workflow-author.nodes.draft'] as (ctx: unknown) => Promise<unknown>;
    const prompts: string[] = [];
    await draft({
      runId: 'parity-live-catalog',
      inputs: { intent: 'anything', maxAttempts: 1 },
      features: {
        'workflow-author': {
          getCatalog: async () => ({ nodes: [{ typeId: 'live.surface.marker', label: 'Live', description: 'from the surface', category: 'flow' }], excluded: [] }),
          validateDraft: async () => ({ ok: false, errors: ['probe'] }),
        },
      },
      callAI: async (req: { systemPrompt?: string }) => { prompts.push(String(req.systemPrompt)); return { content: '' }; },
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('live.surface.marker');
  });

  it('the chat tool builds its catalog from the shared service with tenant curation', () => {
    expect(agentToolsSrc).toContain('buildAuthoringCatalog({ disabledPacks: await resolveDisabledPacks(scope.tenantId) })');
  });

  it('the persist tool derives its clearFields enum from the PRESERVABLE_FIELDS SSoT', () => {
    // ADR 0595 §Correction 1's rule, re-pinned from the parity side: a model told
    // about a field the guard does not protect is being lied to, and a hand-copied
    // enum is where that starts.
    expect(agentToolsSrc).toContain('enum: [...PRESERVABLE_FIELDS]');
  });
});
