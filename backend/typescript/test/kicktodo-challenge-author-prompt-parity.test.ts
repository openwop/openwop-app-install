/**
 * ADR 0458 P1 — Challenge Author prompt↔allowlist parity (the promptCatalogParity
 * precedent, mirrored from `agent-prompt-tool-ids.test.ts` and
 * `kicktodo-artifact-parity.test.ts`).
 *
 * The Challenge Author is the one roster-bound named agent in the kicktodo agents
 * pack, and it names its tools to the model in prose. A prompt that names a tool
 * the model cannot call — or an allowlist that grants a tool the prompt never
 * teaches — is a drift/lie to the model. This pins BOTH directions to the
 * Challenge Author's three tool ids (the two ADR 0458 tools + XCH-HOLE-1's
 * `openwop:kicktodo.challenge-performance` read): the prompt names exactly those
 * `openwop:` ids and no others, and the pack entry's `toolAllowlist` is exactly
 * those three.
 *
 * What reds it: removing a tool from the allowlist or the prompt, naming an
 * unallowlisted `openwop:` id in the prompt, reordering the allowlist, or
 * allowlisting an id no feature registers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { registerKicktodoCreatorAgentTools, KICKTODO_FACTORY_RUN_TOOL_ID } from '../src/features/kicktodo-creator/agentTools.js';
import { registerKicktodoMetricsAgentTools } from '../src/features/kicktodo-metrics/agentTools.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const AGENTS_PACK_DIR = join(REPO, 'packs/vendor.openwop-app.kicktodo.agents');

// Imported by URL href (the claim-extract-node precedent): a bare relative
// specifier makes tsc demand a .d.ts for the .mjs pack.
const nodesPack = (await import(new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href)) as Record<string, unknown>;

const AGENT_ID = 'vendor.openwop-app.kicktodo.agents.challenge-author';
const ALLOWED_TOOL_IDS = ['openwop:kicktodo.candidates', 'openwop:kicktodo.factory.run', 'openwop:kicktodo.challenge-performance'];
const ID_RE = /openwop:[A-Za-z0-9._-]+/g;

const pack = JSON.parse(readFileSync(join(AGENTS_PACK_DIR, 'pack.json'), 'utf8')) as {
  agents: Array<{ agentId: string; systemPromptRef?: string; toolAllowlist?: string[] }>;
};
const entry = pack.agents.find((a) => a.agentId === AGENT_ID);

describe('Challenge Author prompt ↔ allowlist parity (ADR 0458 P1)', () => {
  it('the pack declares the Challenge Author agent with a systemPromptRef', () => {
    expect(entry, `${AGENT_ID} must be declared in the agents pack`).toBeDefined();
    expect(typeof entry?.systemPromptRef).toBe('string');
  });

  it("the entry's toolAllowlist is EXACTLY the Challenge Author's tool ids", () => {
    expect(entry?.toolAllowlist).toEqual(ALLOWED_TOOL_IDS);
  });

  // Read lazily inside the cases, so a missing entry reds case 1 instead of
  // crashing the file at collect time.
  const prompt = (): string => readFileSync(join(AGENTS_PACK_DIR, entry?.systemPromptRef ?? 'MISSING-systemPromptRef'), 'utf8');

  it('the prompt names EVERY allowlisted tool id verbatim', () => {
    for (const id of ALLOWED_TOOL_IDS) {
      expect(prompt().includes(id), `prompt must name ${id} verbatim`).toBe(true);
    }
  });

  it('every allowlisted id is a REGISTERED host tool (an allowlist entry with no tool is a dead grant)', () => {
    registerKicktodoCreatorAgentTools({} as never);
    registerKicktodoMetricsAgentTools();
    for (const id of ALLOWED_TOOL_IDS) expect(builtinAgentTool(id), `${id} must be registered`).toBeDefined();
  });

  it('the prompt names NO other openwop: tool id', () => {
    const mentioned = [...new Set(Array.from(prompt().matchAll(ID_RE), (m) => m[0]))].sort();
    expect(mentioned).toEqual([...ALLOWED_TOOL_IDS].sort());
  });
});

// XCH-CA-1 / XCH-CA-2 — what the prompt COLLECTS and PROMISES has a tool input to
// carry it. The intake the prompt asks for used to be dropped for hard-coded
// defaults, and it promised a per-lesson cadence the executor cannot honour.
describe('Challenge Author prompt ↔ factory.run tool input parity (XCH-CA-1/2)', () => {
  registerKicktodoCreatorAgentTools({} as never);
  const props = (): Record<string, { enum?: string[] }> =>
    (builtinAgentTool(KICKTODO_FACTORY_RUN_TOOL_ID)?.def.inputSchema as { properties?: Record<string, { enum?: string[] }> } | undefined)?.properties ?? {};
  const prompt = (): string => readFileSync(join(AGENTS_PACK_DIR, entry?.systemPromptRef ?? 'MISSING-systemPromptRef'), 'utf8');

  it('every intake item the prompt collects has a tool input', () => {
    for (const [said, input] of [['TOPIC', 'topic'], ['AUDIENCE', 'audience'], ['TRANSFORMATION', 'transformation'], ['DURATION', 'durationDays'], ['DEPTH', 'dailyMinutes']] as const) {
      expect(prompt().includes(said), `the prompt collects ${said}`).toBe(true);
      expect(props()[input], `factory.run must accept \`${input}\` for ${said}`).toBeDefined();
    }
  });

  it('the prompt offers exactly the cadences the tool (and executor) accept, and no per-lesson stop', () => {
    const cadences = props().checkpointEvery?.enum ?? [];
    expect([...cadences].sort()).toEqual(['batched', 'outline-only']);
    for (const c of cadences) expect(prompt().includes(`\`${c}\``), `prompt names ${c}`).toBe(true);
    expect(prompt()).not.toMatch(/after each lesson/i);
  });
});

// XCH-CE-2 / ADR 0903 — the factory pins no AI vendor (the ADR 0505 pin was removed
// on the user's decision, 2026-10-17). Sabotage: restoring a param default or the
// node-side constant turns this red.
describe('factory AI vendor is not pinned (ADR 0903)', () => {
  it('the factory chain declares provider/model params with NO default, and the node pack exports no pinned default', () => {
    const chain = JSON.parse(readFileSync(join(REPO, 'examples/workflow-chain-packs/kicktodo-challenge-factory/pack.json'), 'utf8')) as {
      chains: Array<{ parameters?: { properties?: Record<string, { default?: unknown }> } }>;
    };
    const params = chain.chains[0]?.parameters?.properties ?? {};
    expect(params.provider, 'the param itself stays: a user can still fix a provider').toBeDefined();
    expect(params.provider?.default).toBeUndefined();
    expect(params.model?.default).toBeUndefined();
    expect(nodesPack.FACTORY_AI_DEFAULT).toBeUndefined();
  });
});

// KTF-LB-1 / WF-3 / CFD-2 — every name the build-N subWorkflow nodes map into
// the lesson-batch child is a value the parent run actually has: a parent
// parameter or a declared produced variable. `generateMedia` used to be mapped
// from a bag variable nothing produced, so the media leg was unreachable.
// Sabotage: deleting the `generateMedia` parameter reds this.
describe('factory → lesson-batch inputMapping liveness (KTF-LB-1)', () => {
  it('every mapped source is a parent parameter or a produced variable, and the child declares every mapped target', () => {
    type Chain = {
      chainId: string;
      parameters?: { properties?: Record<string, unknown> };
      producedVariables?: Array<{ name: string }>;
      dag: { nodes: Array<{ id: string; config?: { inputMapping?: Record<string, string>; subChainRef?: string } }> };
    };
    const pack = JSON.parse(readFileSync(join(REPO, 'examples/workflow-chain-packs/kicktodo-challenge-factory/pack.json'), 'utf8')) as { chains: Chain[] };
    const parent = pack.chains.find((c) => c.chainId === 'openwop-app.kicktodo.challenge-factory')!;
    const child = pack.chains.find((c) => c.chainId === 'openwop-app.kicktodo.lesson-batch')!;
    const live = new Set([...Object.keys(parent.parameters?.properties ?? {}), ...(parent.producedVariables ?? []).map((v) => v.name)]);
    const childParams = new Set(Object.keys(child.parameters?.properties ?? {}));
    const builds = parent.dag.nodes.filter((n) => n.config?.subChainRef === child.chainId);
    expect(builds).toHaveLength(4);
    for (const n of builds) {
      for (const [target, source] of Object.entries(n.config?.inputMapping ?? {})) {
        expect(live.has(source), `${n.id} maps ${target} from \`${source}\`, which the parent never has`).toBe(true);
        expect(childParams.has(target), `${n.id} maps \`${target}\`, which the child does not declare`).toBe(true);
      }
    }
    expect(parent.parameters?.properties?.generateMedia).toMatchObject({ type: 'boolean', default: false });
  });
});
