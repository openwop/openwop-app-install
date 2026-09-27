/**
 * Shared `{{namespace.NAME}}` token substitution with whole-value-typed semantics.
 *
 * ONE implementation, two call sites (RFC 0013 amendment 2026-07-04 §WCP2 asked
 * for exactly this — a single raw-typed whole-value rule for both timings):
 *   - EXPAND-time `{{params.*}}` substitution against a chain's resolved params
 *     (RFC 0013 "Path A" expansion-time substitution — `host/workflowChainPackLoader.ts`).
 *   - RUN-time `{{inputs.*}}` resolution of a node.inputs value against the per-run
 *     variable bag (ADR 0237 — `executor/executor.ts`).
 *
 * The whole-value rule (ADR 0237 / WCP2): a string that is EXACTLY one token
 * (`"{{ns.name}}"`, anchored) resolves to the RAW typed bag value — an object,
 * array, number, or boolean survives its JSON type (string-substituting it would
 * stringify an object to `"[object Object]"`). A token EMBEDDED in surrounding
 * text coerces to a string (null/undefined → `''`). A string with no token is
 * returned unchanged. Deep-recurses into arrays/objects; never mutates the input.
 */

/** Anchored (whole-string) matcher for one `{{ns.NAME}}` token. */
function wholeTokenRe(ns: string): RegExp {
  return new RegExp(`^\\{\\{\\s*${ns}\\.([a-zA-Z0-9_]+)\\s*\\}\\}$`);
}

/** Global (embedded) matcher for `{{ns.NAME}}` tokens within a larger string. */
function embeddedTokenRe(ns: string): RegExp {
  return new RegExp(`\\{\\{\\s*${ns}\\.([a-zA-Z0-9_]+)\\s*\\}\\}`, 'g');
}

/**
 * Resolve every `{{ns.NAME}}` token in a SINGLE string `str` against `bag`.
 * - Whole-value token → the raw typed bag value (may be `undefined`).
 * - Embedded token(s) → string with each token replaced (null/undefined → `''`).
 * - No token → the original string, unchanged.
 */
/** ADR 0507 §CHAIN-EMBED-1 — what an EMBEDDED token becomes when its param is
 *  REQUIRED and has no value. Visible, greppable, and obviously not content, so a
 *  model receives a placeholder instead of silently inventing the missing text. */
export const MISSING_REQUIRED_MARKER = (name: string): string => `[missing: ${name}]`;

export function resolveTokenString(
  str: string,
  ns: string,
  bag: Readonly<Record<string, unknown>>,
  /** Params the chain DECLARES REQUIRED. An embedded token for one of these with
   *  no value degrades to a marker rather than `''`. Omitted ⇒ today's behaviour,
   *  so every non-chain caller is unaffected. */
  requiredNames?: ReadonlySet<string>,
): unknown {
  const whole = wholeTokenRe(ns).exec(str);
  if (whole) return bag[whole[1]]; // raw, type-preserving
  const re = embeddedTokenRe(ns);
  if (!re.test(str)) return str;
  return str.replace(embeddedTokenRe(ns), (_m, name: string) => {
    const v = bag[name];
    if (v !== undefined && v !== null) return String(v);
    // CHAIN-EMBED-1: `''` here is why 16 shipped chains FABRICATE. A whole-value
    // token vanishes and the node fails loudly; an embedded one collapses to an
    // empty string, so `"…from the invoice. Invoice: {{params.invoiceText}}"`
    // becomes `"…from the invoice. Invoice: "` — a perfectly valid prompt asking a
    // model to extract line items from nothing. It obliges, and the fabrication
    // reaches an approval gate.
    //
    // ONLY for params the chain declares REQUIRED. An OPTIONAL embedded param must
    // keep collapsing to `''` — a marker there would put noise in every prompt that
    // mentions an optional value.
    if (requiredNames?.has(name)) return MISSING_REQUIRED_MARKER(name);
    return '';
  });
}

/**
 * Deep-substitute `{{ns.NAME}}` tokens in `value` against `bag`, applying the
 * whole-value-typed rule at every string leaf. Objects/arrays recurse; non-string
 * leaves pass through unchanged; the input is never mutated.
 */
export function substituteTokensDeep<T>(
  value: T,
  ns: string,
  bag: Readonly<Record<string, unknown>>,
  requiredNames?: ReadonlySet<string>,
): T {
  if (typeof value === 'string') {
    return resolveTokenString(value, ns, bag, requiredNames) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteTokensDeep(v, ns, bag, requiredNames)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteTokensDeep(v, ns, bag, requiredNames),
      ]),
    ) as unknown as T;
  }
  return value;
}
