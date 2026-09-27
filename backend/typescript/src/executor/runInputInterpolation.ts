/**
 * Run-time interpolation of `{{inputs.NAME}}` tokens in a node's config against
 * the per-run variable bag (ADR 0163 follow-on — reusable workflow templates).
 *
 * A workflow declares its inputs as `variables[]`; the bag is seeded from
 * `POST /v1/runs.inputs` (a caller-supplied value overrides the variable's
 * `defaultValue`). Pack-instantiated templates carry `{{inputs.X}}` tokens in
 * node config (e.g. an LLM `systemPrompt`); this resolves them at execution so
 * ONE owned workflow serves every invocation — the specific value arrives per
 * run, not frozen at instantiate time.
 *
 * This reads the SAME per-run variable bag that `{type:'variable'}` input ports
 * resolve against (single source of truth for run inputs — not a parallel path);
 * it just extends that resolution to config strings. Host-only: the run-creation
 * wire (`inputs` is an opaque, workflow-defined object) is unchanged.
 *
 * Unresolved tokens (no matching variable, no default) collapse to '' — the run
 * proceeds rather than leaking a literal `{{inputs.x}}` into a prompt.
 */

const INPUT_TOKEN_RE = /\{\{\s*inputs\.([a-zA-Z0-9_]+)\s*\}\}/g;

/** True if any node config/inputs still reference a run input (cheap pre-check). */
export function hasInputTokens(value: unknown): boolean {
  if (typeof value === 'string') { INPUT_TOKEN_RE.lastIndex = 0; return INPUT_TOKEN_RE.test(value); }
  if (Array.isArray(value)) return value.some(hasInputTokens);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasInputTokens);
  return false;
}

/**
 * Deep-resolve `{{inputs.NAME}}` tokens in `value` from `bag`. Non-string leaves
 * are returned unchanged; the input object is never mutated.
 */
export function interpolateRunInputs<T>(value: T, bag: Readonly<Record<string, unknown>> | null | undefined): T {
  if (!bag) return value;
  if (typeof value === 'string') {
    return value.replace(INPUT_TOKEN_RE, (_m, name: string) => {
      const v = bag[name];
      return v === undefined || v === null ? '' : String(v);
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateRunInputs(v, bag)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateRunInputs(v, bag)]),
    ) as unknown as T;
  }
  return value;
}
