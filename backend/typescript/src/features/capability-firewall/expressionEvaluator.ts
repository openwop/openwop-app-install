/**
 * ADR 0135 Phase 6 — a bounded, side-effect-free boolean-expression predicate.
 *
 * A hand-written recursive-descent parser + evaluator over a CLOSED grammar (NO `eval`,
 * NO library, no loops, no function calls, no I/O). The fact set is fixed and small: the
 * classes SEEN this turn, the NEXT tool's classes, and per-class COUNTs — the SAME facts
 * the fixed `anyOf`/`with`/`countAtLeast` predicates already see (Phases 1/5). This only
 * lets an operator combine those facts with arbitrary `&&`/`||`/`!` + numeric comparison.
 *
 *   expr := term (('&&' | '||') term)*        // flat, left-to-right (no &&-over-|| precedence)
 *   term := ['!'] fact [('>='|'<='|'>'|'<'|'=='|'!=') number]
 *   fact := ('seen' | 'count' | 'next') '.' <classKeyBody>
 *
 * `<classKeyBody>` is a capability-class key: a bare safetyTier (`read`), or an
 * `egress:host-mediated` / `scope:workspace:write` / `kind:fan-out` form. `seen.X` and
 * `next.X` are booleans (membership); `count.X` is a number. A bare fact is truthy when
 * true / (`count.X`) > 0. `parseExpression` is used at save-time (fail-closed on a bad
 * expression / unknown fact); `evalExpression` is pure and replays deterministically.
 *
 * @see docs/adr/0135-capability-firewall.md (Phase 6)
 */

const SAFETY_TIERS = new Set(['pure', 'read', 'write', 'exec']);
const EGRESS = new Set(['none', 'safe-fetch', 'host-mediated', 'host-owned']);

type CmpOp = '>=' | '<=' | '>' | '<' | '==' | '!=';
type FactNs = 'seen' | 'count' | 'next';

interface Fact { ns: FactNs; key: string }
interface Comparison { op: CmpOp; value: number }
interface Term { neg: boolean; fact: Fact; cmp?: Comparison }
interface Chain { op: '&&' | '||'; term: Term }
export interface Expression { first: Term; rest: Chain[] }

interface EvalContext {
  seen: ReadonlySet<string>;
  next: ReadonlySet<string>;
  counts: ReadonlyMap<string, number>;
}

type Token =
  | { t: 'and' }
  | { t: 'or' }
  | { t: 'not' }
  | { t: 'cmp'; op: CmpOp }
  | { t: 'num'; value: number }
  | { t: 'fact'; ns: FactNs; key: string };

/** Normalize a class-key body to its canonical class key, or null if unknown. */
function normalizeKey(body: string): string | null {
  const colon = body.indexOf(':');
  if (colon < 0) return SAFETY_TIERS.has(body) ? `safetyTier:${body}` : null;
  const ns = body.slice(0, colon);
  const val = body.slice(colon + 1);
  if (!val) return null;
  if (ns === 'safetyTier') return SAFETY_TIERS.has(val) ? body : null;
  if (ns === 'egress') return EGRESS.has(val) ? body : null;
  if (ns === 'kind') return val === 'fan-out' ? body : null;
  if (ns === 'scope') return body;
  return null;
}

const FACT_RE = /^(seen|count|next)\.([a-zA-Z0-9:_-]+)/;

function tokenize(src: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (src.startsWith('&&', i)) { tokens.push({ t: 'and' }); i += 2; continue; }
    if (src.startsWith('||', i)) { tokens.push({ t: 'or' }); i += 2; continue; }
    if (src.startsWith('>=', i)) { tokens.push({ t: 'cmp', op: '>=' }); i += 2; continue; }
    if (src.startsWith('<=', i)) { tokens.push({ t: 'cmp', op: '<=' }); i += 2; continue; }
    if (src.startsWith('==', i)) { tokens.push({ t: 'cmp', op: '==' }); i += 2; continue; }
    if (src.startsWith('!=', i)) { tokens.push({ t: 'cmp', op: '!=' }); i += 2; continue; }
    if (c === '>') { tokens.push({ t: 'cmp', op: '>' }); i += 1; continue; }
    if (c === '<') { tokens.push({ t: 'cmp', op: '<' }); i += 1; continue; }
    if (c === '!') { tokens.push({ t: 'not' }); i += 1; continue; }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      tokens.push({ t: 'num', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    const m = FACT_RE.exec(src.slice(i));
    if (m) {
      const key = normalizeKey(m[2]);
      if (key === null) return { ok: false, error: `unknown fact: ${m[1]}.${m[2]}` };
      tokens.push({ t: 'fact', ns: m[1] as FactNs, key });
      i += m[0].length;
      continue;
    }
    return { ok: false, error: `unexpected token at position ${i}: ${JSON.stringify(src.slice(i, i + 8))}` };
  }
  return { ok: true, tokens };
}

class ParseError extends Error {}

class Parser {
  private i = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  private peek(): Token | undefined { return this.tokens[this.i]; }
  atEnd(): boolean { return this.i >= this.tokens.length; }

  parseExpr(): Expression {
    const first = this.parseTerm();
    const rest: Chain[] = [];
    for (let t = this.peek(); t && (t.t === 'and' || t.t === 'or'); t = this.peek()) {
      this.i += 1;
      rest.push({ op: t.t === 'and' ? '&&' : '||', term: this.parseTerm() });
    }
    return { first, rest };
  }

  private parseTerm(): Term {
    let neg = false;
    if (this.peek()?.t === 'not') { neg = true; this.i += 1; }
    const f = this.peek();
    if (!f || f.t !== 'fact') throw new ParseError('expected a fact (seen./count./next.<class>)');
    this.i += 1;
    const fact: Fact = { ns: f.ns, key: f.key };
    const c = this.peek();
    if (c && c.t === 'cmp') {
      this.i += 1;
      const num = this.peek();
      if (!num || num.t !== 'num') throw new ParseError('a comparison must be followed by a number');
      this.i += 1;
      return { neg, fact, cmp: { op: c.op, value: num.value } };
    }
    return { neg, fact };
  }
}

/** Parse an expression at rule-save time. `ok:false` carries a human-readable error. */
export function parseExpression(src: string): { ok: true; ast: Expression } | { ok: false; error: string } {
  const tk = tokenize(src);
  if (!tk.ok) return tk;
  if (tk.tokens.length === 0) return { ok: false, error: 'empty expression' };
  const parser = new Parser(tk.tokens);
  let ast: Expression;
  try {
    ast = parser.parseExpr();
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : 'malformed expression' };
  }
  if (!parser.atEnd()) return { ok: false, error: 'trailing tokens after a complete expression' };
  return { ok: true, ast };
}

function numericValue(fact: Fact, ctx: EvalContext): number {
  if (fact.ns === 'count') return ctx.counts.get(fact.key) ?? 0;
  if (fact.ns === 'seen') return ctx.seen.has(fact.key) ? 1 : 0;
  return ctx.next.has(fact.key) ? 1 : 0;
}

function evalTerm(term: Term, ctx: EvalContext): boolean {
  const n = numericValue(term.fact, ctx);
  let base: boolean;
  if (term.cmp) {
    const { op, value } = term.cmp;
    base = op === '>=' ? n >= value
      : op === '<=' ? n <= value
        : op === '>' ? n > value
          : op === '<' ? n < value
            : op === '==' ? n === value
              : n !== value;
  } else {
    base = n > 0; // bare: membership (seen/next) or count > 0
  }
  return term.neg ? !base : base;
}

/** Evaluate a parsed expression. PURE: no I/O, deterministic over the reconstructed facts. */
export function evalExpression(ast: Expression, ctx: EvalContext): boolean {
  let acc = evalTerm(ast.first, ctx);
  for (const link of ast.rest) {
    const v = evalTerm(link.term, ctx);
    acc = link.op === '&&' ? acc && v : acc || v;
  }
  return acc;
}
