/**
 * ADR 0602 — an MCP tool projection describes each argument TWICE. The two
 * descriptions must agree.
 *
 * THE DEFECT THIS EXISTS FOR (`NBWF-1` / `NBC-5`). A projection chain carries:
 *
 *   - the `expose` node's `config.inputSchema` — the WIRE contract. An MCP
 *     `tools/call` is Ajv-validated against it (`mcpSemantics.ts`,
 *     `toolSchemaValidation.ts`, `coerceTypes` unset), so a client MUST send the
 *     declared type.
 *   - the chain's `parameters` — the LAUNCH contract. `expandChain({deferred:true})`
 *     materializes it into `variables[]` + `configurableSchema`, which is what
 *     `/builder`, the `/` picker and `…/workflows/from-chain` present, and what
 *     `routes/runs.ts` validates a run's `configurable` against.
 *
 * `notebooks.mcp.search` and `notebooks.mcp.ask` declared `topK` as an `integer`
 * on the wire and a **string** in the launch contract. A caller honouring the
 * launch contract sent `"5"`; Path-A/deferred substitution preserves the JSON
 * type, and the backing node's `typeof i.topK === 'number'` check then dropped it —
 * so the search ran at the host default fan-out and **reported success**. A
 * wrong-sized result set presented as a right one.
 *
 * WHY THIS IS A NEW FILE RATHER THAN A WIDENING (the disposition, recorded).
 * `chain-node-undeclared-keys.test.ts` was nominated as the gate that should have
 * caught this. It cannot, under any declaration: it compares node `config`/`inputs`
 * KEY NAMES against a node's declared schemas, it never reads `chain.parameters`,
 * and it never compares a TYPE. `topK` is a legitimately-declared key on both
 * sides — a key-presence gate is structurally incapable of seeing that the two
 * sides disagree about what it holds. (Its own separate vacuity — 112 chain-used
 * node typeIds across 31 packs declare neither schema — is real, corpus-wide, and
 * deferred with that measurement in ADR 0602 § Residuals. Widening a
 * structurally-blind instrument produces a second blind instrument.)
 *
 * THE GENERATORS ARE THE POPULATION, NOT THE INSTANCES. Four features generate
 * these projections. Two hard-coded `type: 'string'` for every variable
 * (`features/notebooks/mcpToolsWorkflows.ts`, `features/docs/mcpToolsWorkflows.ts` —
 * whose docblock says it mirrors notebooks "EXACTLY", and it mirrored the defect
 * too). This gate found `docs.mcp.docs_search.limit`, which no tracker had filed.
 *
 * SIGNAL: the counts in the fixture guard. A drop in `pairsChecked` or
 * `chainsScanned` is this file going quiet, which is indistinguishable from it
 * passing unless the guard asserts the floor.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { notebookMcpToolWorkflows } from '../src/features/notebooks/mcpToolsWorkflows.js';
import { docsMcpToolWorkflows } from '../src/features/docs/mcpToolsWorkflows.js';
import { ucpMcpToolWorkflows } from '../src/features/commerce/ucp/ucpMcpTools.js';
import { appBuilderMcpControlWorkflows } from '../src/features/app-builder/mcpControlWorkflows.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';

/** `schemas/workflow-definition.schema.json` → `WorkflowVariable.type`. NOTE the
 *  absence of `integer`: `expandChain` copies a chain param's `type` VERBATIM onto
 *  the materialized variable, so a chain param typed `integer` yields a definition
 *  invalid against the host's own schema. This is why the fix maps `integer` to
 *  `number` rather than "carrying the real type" literally. */
const WORKFLOW_VARIABLE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'object', 'array']);

/** The ONE normalization, stated once. A JSON-Schema `integer` and a
 *  WorkflowVariable `number` are the same claim; anything else must match exactly. */
const norm = (t: unknown): unknown => (t === 'integer' ? 'number' : t);

interface JsonSchemaish { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: unknown }
interface ExposeConfig { name?: unknown; description?: unknown; inputSchema?: JsonSchemaish }
interface ChainNode { id: string; typeId: string; config?: ExposeConfig }
interface Chain { chainId: string; parameters?: JsonSchemaish; dag?: { nodes?: ChainNode[] } }

interface Projection {
  pack: string;
  chainId: string;
  params: JsonSchemaish;
  tool: JsonSchemaish;
  /** The WHOLE expose config (`name`/`description`/`inputSchema`), not just the
   *  bit a keyword comparison happens to look at — see the deep-compare below. */
  expose: ExposeConfig;
}

function loadProjections(): Projection[] {
  const out: Projection[] = [];
  const root = join(REPO, 'examples', 'workflow-chain-packs');
  for (const dir of readdirSync(root)) {
    const manifest = join(root, dir, 'pack.json');
    if (!existsSync(manifest)) continue;
    const pack = JSON.parse(readFileSync(manifest, 'utf8')) as { chains?: Chain[] };
    for (const chain of pack.chains ?? []) {
      const expose = (chain.dag?.nodes ?? []).find((n) => n.typeId === EXPOSE_TOOL);
      const tool = expose?.config?.inputSchema;
      if (!tool || !expose?.config) continue;
      out.push({ pack: dir, chainId: chain.chainId, params: chain.parameters ?? {}, tool, expose: expose.config });
    }
  }
  return out;
}

const projections = loadProjections();

describe('MCP tool projections: the wire contract and the launch contract agree', () => {
  it('fixture guard: projections and argument pairs were actually found', () => {
    // Real values at ADR 0602: 19 projections, 31 param↔inputSchema pairs. The
    // floors sit just under, not far below — a slack floor is a guard that has
    // already stopped guarding. If a glob, a pack layout or the expose typeId is
    // renamed, this file would otherwise pass by scanning nothing.
    expect(projections.length, 'no expose-tool chains scanned').toBeGreaterThan(15);
    const pairs = projections.reduce(
      (n, p) => n + Object.keys(p.params.properties ?? {}).filter((k) => (p.tool.properties ?? {})[k]).length,
      0,
    );
    expect(pairs, 'no param↔inputSchema pairs to compare — the assertions below are vacuous').toBeGreaterThan(25);

    // The interesting case must be REPRESENTED. Every pair being `string↔string`
    // would satisfy the parity assertion while proving nothing: the defect was a
    // non-string wire type flattened to a string launch type, so at least one
    // non-string pair must exist for the comparison to have any discriminating
    // power at all.
    //
    // CORRECTED (ADR 0602 § Correction log, item A). The count in this comment
    // said **6**; the measured value is **7**, and the floor was `> 3`. Reverting
    // ALL THREE of this PR's param fixes to `string` leaves 4 — so the floor
    // PASSED on the exact regression it was written for. A floor that survives
    // its own regression is decoration. Two changes: the floor is now the real
    // value (`> 6`), and the three fixed pairs are named, because a floor can
    // only see the SIZE of the population and the regression is about its
    // MEMBERS. Real value at ADR 0602: 7 —
    //   commerce.ucp.mcp.place-order.lines (array),
    //   docs.mcp.docs_search.limit, notebooks.mcp.search.topK,
    //   notebooks.mcp.ask.topK (number — the three this PR fixed),
    //   app-builder.mcp.render-design.app (object), .baseVersion (number),
    //   app-builder.mcp.resolve-paused-task.value (object).
    const nonString = projections.flatMap((p) =>
      Object.entries(p.params.properties ?? {})
        .filter(([k, v]) => (p.tool.properties ?? {})[k] && norm(v.type) !== 'string')
        .map(([k]) => `${p.chainId}.${k}`));
    expect(nonString.length, 'every compared argument is a string — this gate cannot discriminate').toBeGreaterThan(6);
    // The named regression. `NBWF-1` was these three flattened to `string`; a
    // count floor cannot distinguish "these three reverted" from "three other
    // projections retired". Membership can.
    for (const pair of ['docs.mcp.docs_search.limit', 'notebooks.mcp.search.topK', 'notebooks.mcp.ask.topK']) {
      expect(nonString, `${pair} is a string again — this is NBWF-1 verbatim`).toContain(pair);
    }
  });

  it('every launch-contract parameter declares the SAME type as the wire contract', () => {
    const drift: string[] = [];
    for (const p of projections) {
      for (const [name, spec] of Object.entries(p.params.properties ?? {})) {
        const wire = (p.tool.properties ?? {})[name];
        if (!wire) continue; // key-set parity is the next assertion's job
        if (norm(spec.type) !== norm(wire.type)) {
          drift.push(`${p.pack}/${p.chainId}.${name}: parameters=${String(spec.type)} vs inputSchema=${String(wire.type)}`);
        }
      }
    }
    expect(drift, 'an MCP projection advertises one type on the wire and another in its launch contract').toEqual([]);
  });

  it('the two contracts declare the SAME argument names', () => {
    // A tool argument with no chain parameter is unreachable from the
    // from-chain/builder lane; a chain parameter with no tool argument is
    // unreachable from the MCP lane. Both are a projection that is only half real.
    const drift: string[] = [];
    for (const p of projections) {
      const params = new Set(Object.keys(p.params.properties ?? {}));
      const wire = new Set(Object.keys(p.tool.properties ?? {}));
      for (const k of params) if (!wire.has(k)) drift.push(`${p.chainId}: parameter '${k}' has no tool argument`);
      for (const k of wire) if (!params.has(k)) drift.push(`${p.chainId}: tool argument '${k}' has no chain parameter`);
    }
    expect(drift).toEqual([]);
  });

  it('the two contracts agree on which arguments are REQUIRED', () => {
    const drift: string[] = [];
    for (const p of projections) {
      const a = new Set(Array.isArray(p.params.required) ? (p.params.required as string[]) : []);
      const b = new Set(Array.isArray(p.tool.required) ? (p.tool.required as string[]) : []);
      for (const k of new Set([...a, ...b])) {
        if (a.has(k) !== b.has(k)) drift.push(`${p.chainId}.${k}: parameters.required=${a.has(k)} vs inputSchema.required=${b.has(k)}`);
      }
    }
    expect(drift, 'a projection disagrees with itself about which arguments are mandatory').toEqual([]);
  });

  it('every launch-contract parameter type is REPRESENTABLE as a WorkflowVariable', () => {
    // The guard against this fix committing the family it closes. The steward cure
    // for `NBWF-1` reads "carry each variable's real type from the inputSchema";
    // applied literally it writes `integer` into `chain.parameters`, `expandChain`
    // copies it verbatim onto `variables[].type`, and the resulting definition is
    // invalid against `schemas/workflow-definition.schema.json`. That failure would
    // surface far from here, so it is asserted here.
    const bad: string[] = [];
    for (const p of projections) {
      for (const [name, spec] of Object.entries(p.params.properties ?? {})) {
        if (!WORKFLOW_VARIABLE_TYPES.has(String(spec.type))) bad.push(`${p.chainId}.${name}: '${String(spec.type)}'`);
      }
    }
    expect(bad, `a chain parameter type is outside WorkflowVariable.type (${[...WORKFLOW_VARIABLE_TYPES].join('|')})`).toEqual([]);
  });
});

describe('the in-tree generator SSoT and the shipped chain packs agree', () => {
  // The chain packs were generated FROM these arrays (ADR 0472 P4) and the arrays
  // remain the readable SSoT. Nothing asserted they still matched, so the pack
  // could be repaired while the generator kept emitting the defect — and the next
  // regeneration would reintroduce it. This is the assertion that makes the
  // generator fix load-bearing rather than cosmetic.
  //
  // CORRECTED (ADR 0602 § Correction log, item A). This describe used to compare
  // ONE keyword — `type` — across `src.variables`. Everything else the two sides
  // both describe (`required`, `minimum`/`maximum`, `enum`, `minLength`,
  // `description`, the tool `name`) could be edited on BOTH sides of the pack and
  // never be checked against the SSoT at all. PROVED: dropping `notebookId` from
  // both `parameters.required` and `expose.config.inputSchema.required`, plus
  // narrowing `topK.maximum` 50→5, left the whole file GREEN. That is not a
  // cosmetic gap — an unrequired `notebookId` makes `notebook-search` callable
  // with none, `surface.ts` resolves `null`, and the tool returns
  // `{hits:[],citations:[]}` with `status:'success'`: the success-with-empty
  // non-negotiable, shipped by a gate that reported parity.
  //
  // The replacement is a DEEP compare of the whole artifact in both directions,
  // not a longer list of keywords. A keyword list is a claim about which fields
  // matter, and that claim was wrong once already.
  const sources = [
    ...notebookMcpToolWorkflows, ...docsMcpToolWorkflows,
    ...ucpMcpToolWorkflows, ...appBuilderMcpControlWorkflows,
  ];
  const byId = new Map(projections.map((p) => [p.chainId, p]));

  it('fixture guard: the generator arrays are populated and resolve to packed chains', () => {
    expect(sources.length, 'no generated projection workflows').toBeGreaterThan(15);
    const matched = sources.filter((s) => byId.has(s.workflowId));
    expect(matched.length, 'no generated workflow resolves to a shipped chain — the join key changed').toBeGreaterThan(15);
  });

  /** The expose node's WHOLE config as the generator emits it. */
  function generatedExpose(src: (typeof sources)[number]): unknown {
    return (src.nodes ?? []).find((n) => n.typeId === EXPOSE_TOOL)?.config;
  }

  /** The chain `parameters` block the generator's `variables[]` IMPLIES. This is
   *  the shape the ADR 0472 P4 migration emitted, restated as a function so the
   *  pack is compared against a DERIVATION rather than against itself. `required`
   *  is omitted when empty — that is the packed convention (4 of 19 chains). */
  function impliedParameters(src: (typeof sources)[number]): JsonSchemaish {
    const vars = src.variables ?? [];
    const required = vars.filter((v) => v.required).map((v) => v.name);
    return {
      type: 'object',
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
      properties: Object.fromEntries(vars.map((v) => [v.name, { type: v.type, description: v.description }])),
    } as JsonSchemaish;
  }

  it('the shipped WIRE contract is deep-equal to the generator tool manifest', () => {
    // `name`, `description`, `inputSchema` — including every keyword inside it
    // (`required`, `minimum`, `maximum`, `enum`, `additionalProperties`, nested
    // property descriptions). One structural comparison, so nothing is in scope
    // only because someone remembered to name it.
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const src of sources) {
      const packed = byId.get(src.workflowId);
      if (!packed) continue;
      actual[src.workflowId] = packed.expose;
      expected[src.workflowId] = generatedExpose(src);
    }
    expect(Object.keys(actual).length, 'nothing compared — the join key changed').toBeGreaterThan(15);
    expect(actual, 'a shipped expose-tool manifest differs from the in-tree generator — regenerating would undo the pack').toEqual(expected);
  });

  it('the shipped LAUNCH contract is deep-equal to the one the generator implies', () => {
    // Subsumes the old `type`-only walk and adds `required`, `description`, the
    // param key-set in both directions, and `additionalProperties`.
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const src of sources) {
      const packed = byId.get(src.workflowId);
      if (!packed) continue;
      actual[src.workflowId] = packed.params;
      expected[src.workflowId] = impliedParameters(src);
    }
    expect(Object.keys(actual).length, 'nothing compared — the join key changed').toBeGreaterThan(15);
    expect(actual, 'a shipped chain parameters block differs from the in-tree generator — regenerating would undo the pack').toEqual(expected);
  });
});
