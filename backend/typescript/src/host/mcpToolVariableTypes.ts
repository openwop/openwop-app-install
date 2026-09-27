/**
 * ADR 0602 — the ONE rule mapping an MCP tool's `inputSchema` property type onto
 * the `WorkflowVariable.type` a projection workflow declares for the same name.
 *
 * WHY THIS EXISTS. An MCP tool projection describes ONE argument in two places:
 * the expose-tool node's `inputSchema` (the wire contract an MCP client is
 * validated against) and the workflow's `variables[]` (which, once the workflow
 * is migrated to a chain, becomes the chain's `parameters` — the LAUNCH CONTRACT
 * the `/builder`, the `/` picker and `…/workflows/from-chain` honour). Two
 * generators hard-coded `type: 'string'` for every variable regardless of the
 * schema, so three arguments across two features advertised a launch contract
 * that contradicted their own tool contract (`NBWF-1`: `notebooks.mcp.search`
 * and `.ask` `topK`; plus the previously-unfiled `docs.mcp.docs_search` `limit`).
 *
 * THE `integer` TRAP — and why the obvious cure is wrong. The steward cure filed
 * for `NBWF-1` reads "carry each variable's real type from
 * `spec.inputSchema.properties[v.name].type`". Applied literally that emits
 * `type: 'integer'`, and `schemas/workflow-definition.schema.json`
 * (`WorkflowVariable.type`) admits only `string | number | boolean | object |
 * array` — no `integer`. `expandChain` copies a chain param's `type` VERBATIM onto
 * the materialized variable (`workflowChainPackLoader.ts`, deferred mode), so the
 * literal cure would have produced definitions invalid against the host's own
 * schema. `integer` is therefore WIDENED to `number` here, once, with the numeric
 * bound left on the tool `inputSchema` where a validator actually reads it.
 *
 * FAIL-CLOSED. An unrepresentable or missing type THROWS at module evaluation
 * rather than defaulting to `'string'` — silently defaulting to `'string'` is the
 * precise defect this module closes. Every input is an in-repo static literal, so
 * this is unreachable from any request path: a bad edit is a deterministic
 * boot/test failure, never a runtime surprise.
 *
 * @see docs/adr/0602-notebooks-topk-and-locale-truth.md
 * @see backend/typescript/test/mcp-projection-param-type-parity.test.ts
 */

/** The five values `schemas/workflow-definition.schema.json` allows for
 *  `WorkflowVariable.type`. Note the ABSENCE of `integer`. */
export type WorkflowVariableType = 'string' | 'number' | 'boolean' | 'object' | 'array';

const REPRESENTABLE: ReadonlySet<string> = new Set<WorkflowVariableType>([
  'string', 'number', 'boolean', 'object', 'array',
]);

/**
 * The `WorkflowVariable.type` for `name`, derived from the tool's own
 * `inputSchema`. Single source of truth: the schema, never a parallel hand-kept
 * literal.
 *
 * @throws Error when the property is absent or its type is not representable —
 *   both are authoring defects in a static in-repo literal.
 */
export function workflowVariableTypeFor(inputSchema: unknown, name: string): WorkflowVariableType {
  const props = (inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
  const declared = props?.[name]?.type;
  if (typeof declared !== 'string') {
    throw new Error(
      `mcp tool variable '${name}' has no declared type in the tool inputSchema — `
      + 'a projection variable MUST be derived from the tool contract, not guessed (ADR 0602).',
    );
  }
  // The one widening: JSON Schema's `integer` has no WorkflowVariable counterpart.
  const mapped = declared === 'integer' ? 'number' : declared;
  if (!REPRESENTABLE.has(mapped)) {
    throw new Error(
      `mcp tool variable '${name}' declares type '${declared}', which has no WorkflowVariable `
      + `counterpart (allowed: ${[...REPRESENTABLE].join(', ')}) — ADR 0602.`,
    );
  }
  return mapped as WorkflowVariableType;
}
