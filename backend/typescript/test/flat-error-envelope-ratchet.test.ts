/**
 * H27 / S22 — the NO-REGROWTH ratchet for the flat error envelope.
 *
 * `flat-error-envelope.test.ts` drives a cross-section of converted routes over
 * real HTTP. It cannot cover them all, and — more importantly — it cannot cover
 * the route somebody adds NEXT WEEK by copying a neighbouring handler. That is
 * exactly how the nested `{ error: { code, message, retriable } }` form reached
 * ~88 sites: each one was copied from the one beside it, every test stayed
 * green, and the drift was only visible by reading the whole surface at once.
 *
 * So this is a STATIC scan of the route + feature-route source text. It fails if
 * any `res.status(…).json({ error: { … } })` reappears — the emit shape, read
 * off the source, with no dependence on a test happening to hit that route.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG. Four error objects are legitimately
 * nested and are NOT this envelope (`conformance/src/lib/error-envelope.ts`
 * header names the first three; the fourth follows from the schema):
 *
 *   1. `RunSnapshot.error` / the `run.failed` + `node.failed` event payloads —
 *      `{ code, message, retriable? }`, `run-snapshot.schema.json`. Run-level,
 *      not HTTP.
 *   2. Bulk-result items — `{ ok: false, error: { code } }`, pinned by
 *      `rest-endpoints.md` §"Bulk cancel".
 *   3. JSON-RPC bodies on the MCP / A2A mounts — `{ error: { code, message } }`
 *      with NUMERIC codes; a different protocol's envelope, carried at HTTP 200.
 *   4. Result DOCUMENTS that carry `error` beside other top-level keys — the
 *      sandbox seam's `200 { error: SandboxError }` (`host-sample-test-seams.md`
 *      §"sandbox-invoke"), the ui-plugin `{ ok, result?, error? }` response, the
 *      toolhooks seam's `{ toolCalled, toolReturned, error? }`. These cannot be
 *      envelopes under `additionalProperties: false`, so flattening them would
 *      break a pinned contract rather than fix one.
 *
 * The scan is therefore narrowed to the one shape that is unambiguously the
 * HTTP envelope: a `res.status(<non-2xx>).json({ error: { … } })` whose JSON
 * argument's ONLY top-level key is `error`. Classes 1–2 and 4 fail that test
 * structurally; class 3 fails it because a JSON-RPC body always carries
 * `jsonrpc` + `id` beside `error` and rides a 200.
 *
 * @see spec/v1/rest-endpoints.md §"Error response shape"
 * @see src/middleware/errorEnvelope.ts (`sendError`, the ONE emitter)
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('../src', import.meta.url)));

/** Every `.ts` under the scanned roots, tests excluded. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Index of the bracket matching the one opened at `start`, string-literal and
 *  template-literal aware (a `}` inside a template expression must not close
 *  the object). */
function matchBracket(s: string, start: number): number {
  const open = s[start]!;
  const close = ({ '{': '}', '(': ')', '[': ']' } as Record<string, string>)[open]!;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      let braces = 0;
      for (; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (q === '`' && s[i] === '$' && s[i + 1] === '{') { braces++; i++; continue; }
        if (q === '`' && braces > 0 && s[i] === '}') { braces--; continue; }
        if (s[i] === q && braces === 0) break;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split an object literal's inner text on TOP-LEVEL commas. */
function splitTop(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      let braces = 0;
      for (; i < inner.length; i++) {
        if (inner[i] === '\\') { i++; continue; }
        if (q === '`' && inner[i] === '$' && inner[i + 1] === '{') { braces++; i++; continue; }
        if (q === '`' && braces > 0 && inner[i] === '}') { braces--; continue; }
        if (inner[i] === q && braces === 0) break;
      }
      continue;
    }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(inner.slice(start, i)); start = i + 1; }
  }
  const tail = inner.slice(start);
  if (tail.trim()) out.push(tail);
  return out;
}

export interface NestedEmit { file: string; line: number; snippet: string }
export interface ShapeViolation extends NestedEmit { reason: string }

/** The marker a body must carry to opt OUT of envelope scanning. Deliberately an
 *  explicit, greppable declaration on the emit rather than a file allowlist in
 *  this test: an allowlist rots silently as files move, while a marker is a
 *  visible act in the diff that adds it, and it states its reason at the site. */
const EXEMPT_MARKER = 'openwop-envelope-exempt:';

/** Parse a `res.status(<s>).json(<arg>)` emit. Returns null when the call is not
 *  of that shape or the body is not an object literal. */
interface Emit { index: number; status: string; parts: string[]; end: number }
function* emits(source: string): Generator<Emit> {
  const re = /res\s*\.status\(|res\.status\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const parenOpen = source.indexOf('(', m.index);
    const parenClose = matchBracket(source, parenOpen);
    if (parenClose < 0) continue;
    const status = source.slice(parenOpen + 1, parenClose).trim();
    const after = source.slice(parenClose + 1);
    const jm = /^\s*\.json\(/.exec(after);
    if (!jm) continue;
    const jsonOpen = parenClose + jm[0].length;
    const jsonClose = matchBracket(source, jsonOpen);
    if (jsonClose < 0) continue;
    const arg = source.slice(jsonOpen + 1, jsonClose).trim();
    if (!arg.startsWith('{') || matchBracket(arg, 0) !== arg.length - 1) continue;
    yield { index: m.index, status, parts: splitTop(arg.slice(1, matchBracket(arg, 0))), end: jsonClose };
  }
}

function keyOf(part: string): string | null {
  const m = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/.exec(part);
  if (m) return m[1] ?? m[2] ?? m[3] ?? null;
  const sh = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
  return sh ? sh[1]! : null;
}
function valueOf(part: string): string | null {
  const m = /^\s*(?:'[^']+'|"[^"]+"|[A-Za-z_$][\w$]*)\s*:/.exec(part);
  return m ? part.slice(m[0].length).trim() : null;
}

/**
 * The top-level keys a body literal contributes, INCLUDING those a conditional
 * spread can introduce. `...(cond ? {} : { details: … })` contributes `details`;
 * `...(x ? { reason } : {})` contributes `reason`. Resolving spreads matters in
 * both directions: without it the canonical `scheduler.ts` emit reads as a
 * violation, and the `connections` emit that really did put `reason` at the top
 * level reads as clean.
 */
function topLevelKeys(parts: string[]): string[] {
  const keys: string[] = [];
  for (const part of parts) {
    const k = keyOf(part);
    if (k !== null) { keys.push(k); continue; }
    if (!/^\s*\.\.\./.test(part)) continue;
    // Pull every object literal out of the spread expression and take its keys.
    for (let i = 0; i < part.length; i++) {
      if (part[i] !== '{') continue;
      const close = matchBracket(part, i);
      if (close < 0) break;
      for (const inner of splitTop(part.slice(i + 1, close))) {
        const ik = keyOf(inner);
        if (ik !== null) keys.push(ik);
      }
      i = close;
    }
  }
  return keys;
}

function snippetAt(source: string, emit: Emit): string {
  return source.slice(emit.index, Math.min(emit.end + 1, emit.index + 160)).replace(/\s+/g, ' ');
}
function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
/**
 * True when the emit itself, or the comment block IMMEDIATELY above it, carries
 * the opt-out marker.
 *
 * Bounded by the comment block rather than by a character window on purpose: a
 * fixed lookback of N characters silently extends one emit's exemption over its
 * neighbours, so a marker written for a readiness report would quietly excuse
 * the next refusal below it. Walking back only while the lines are comments ties
 * the permission to the thing it was written for.
 */
function isExempt(source: string, emit: Emit): boolean {
  if (source.slice(source.lastIndexOf('\n', emit.index) + 1, emit.end + 1).includes(EXEMPT_MARKER)) return true;
  const before = source.slice(0, source.lastIndexOf('\n', emit.index) + 1).split('\n');
  before.pop(); // the (empty) trailing element after the final newline
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i]!.trim();
    if (line === '') continue;
    if (!(line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))) return false;
    if (line.includes(EXEMPT_MARKER)) return true;
  }
  return false;
}

/**
 * Every `res.status(<status>).json({ error: { … } })` where the body's ONLY
 * top-level key is `error` and the status is not 2xx — i.e. an HTTP error
 * envelope emitted in the nested shape. Exported so the sabotage leg can call
 * it against a synthetic source string.
 */
export function findNestedEnvelopeEmits(source: string, file = '<memory>'): NestedEmit[] {
  const hits: NestedEmit[] = [];
  for (const emit of emits(source)) {
    // A 2xx body is a result document, never an error envelope (class 4).
    if (/^2\d\d$/.test(emit.status)) continue;
    // More than one top-level key ⇒ a result document (classes 2–4), not an envelope.
    if (emit.parts.length !== 1) continue;
    if (keyOf(emit.parts[0]!) !== 'error') continue;
    const value = valueOf(emit.parts[0]!);
    if (!value || !value.startsWith('{')) continue; // already flat — the canonical shape
    hits.push({ file, line: lineAt(source, emit.index), snippet: snippetAt(source, emit) });
  }
  return hits;
}

/**
 * H27-b — the OTHER half of the envelope contract, and the half that stayed
 * broken while the nesting was being fixed. `error-envelope.schema.json` also
 * says `message` is REQUIRED and `additionalProperties: false`. Sixty-five emits
 * satisfied "error is a string" and violated one or both: 60 omitted `message`
 * entirely (so a 404 or a 401 arrived with no explanation at all, and every
 * client fell back to rendering a bare status), and 20 carried a top-level
 * `detail` / `reason` / `errors` / `registeredIds` / `foreign` that the schema
 * forbids.
 *
 * Scope: a non-2xx `.json()` whose top-level `error` is a STRING — i.e. a body
 * that is already claiming to be the flat envelope. A body that is not making
 * that claim (a readiness report, a JSON-RPC frame) opts out with an explicit
 * `openwop-envelope-exempt:` marker stating why, which is greppable and shows up
 * in review; a file allowlist here would rot the first time a file moved.
 */
export function findShapeViolations(source: string, file = '<memory>'): ShapeViolation[] {
  const hits: ShapeViolation[] = [];
  for (const emit of emits(source)) {
    if (/^2\d\d$/.test(emit.status)) continue;
    const keys = topLevelKeys(emit.parts);
    const errIdx = emit.parts.findIndex((p) => keyOf(p) === 'error');
    if (errIdx < 0) continue;
    const value = valueOf(emit.parts[errIdx]!);
    // `{ error: { … } }` is the NESTED shape — findNestedEnvelopeEmits owns it.
    if (value !== null && value.startsWith('{')) continue;
    if (isExempt(source, emit)) continue;
    const extras = keys.filter((k) => k !== 'error' && k !== 'message' && k !== 'details');
    const reasons: string[] = [];
    if (!keys.includes('message')) reasons.push('`message` is REQUIRED and absent');
    if (extras.length > 0) reasons.push(`top-level key(s) the schema forbids: ${extras.join(', ')}`);
    if (reasons.length === 0) continue;
    hits.push({
      file,
      line: lineAt(source, emit.index),
      snippet: snippetAt(source, emit),
      reason: reasons.join('; '),
    });
  }
  return hits;
}

describe('H27 ratchet — no route re-grows the nested error envelope', () => {
  it('no `res.status(4xx|5xx).json({ error: { … } })` anywhere under src/', () => {
    // The whole of `src`, not just `routes` + `features`: an HTTP error can be
    // emitted from a middleware or a host module too, and a ratchet that stops
    // at the directory where today's drift happens to live is a ratchet the next
    // one walks around. MEASURED at authoring time: zero matches outside
    // routes/features across 523 files, so widening costs nothing and closes the
    // gap permanently.
    const files = walk(SRC);
    // Non-vacuity: the scan must actually have source to read.
    expect(files.length).toBeGreaterThan(400);

    const hits: NestedEmit[] = [];
    for (const f of files) {
      hits.push(...findNestedEnvelopeEmits(readFileSync(f, 'utf8'), f.slice(SRC.length + 1)));
    }
    expect(
      hits.map((h) => `${h.file}:${h.line}  ${h.snippet}`),
      'The canonical HTTP error envelope is FLAT — `{ error: "<code>", message, details? }` '
        + '(schemas/error-envelope.schema.json, rest-endpoints.md §"Error response shape"). '
        + 'Emit it through `sendError(res, status, code, message, details?)` from '
        + 'src/middleware/errorEnvelope.ts. `retriable` and every other contextual fact '
        + 'belongs under `details` — `additionalProperties: false` forbids a new top level.',
    ).toEqual([]);
  });

  it('the scan actually detects a nested emit (it is not a grep that can never match)', () => {
    // The guard that makes the guard real: a green ratchet must be
    // distinguishable from a ratchet whose pattern never matches anything.
    const sabotage = `
      app.post('/x', (req, res) => {
        res.status(400).json({ error: { code: 'validation_error', message: 'nope' } });
      });
    `;
    const hits = findNestedEnvelopeEmits(sabotage, 'synthetic.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
  });

  it('no flat error body omits `message` or carries a key outside {error,message,details}', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(400);
    const hits: ShapeViolation[] = [];
    for (const f of files) {
      hits.push(...findShapeViolations(readFileSync(f, 'utf8'), f.slice(SRC.length + 1)));
    }
    expect(
      hits.map((h) => `${h.file}:${h.line}  ${h.reason}\n    ${h.snippet}`),
      'error-envelope.schema.json REQUIRES `message` and is `additionalProperties: false`. '
        + 'Emit through `sendError(res, status, code, message, details?)` and put contextual '
        + 'data under `details`. A body that is deliberately NOT an error envelope (a readiness '
        + `report, a JSON-RPC frame) declares that with an inline \`${EXEMPT_MARKER}\` marker `
        + 'stating why.',
    ).toEqual([]);
  });

  it('the shape scan detects both violations, and clears a canonical emit', () => {
    // Same non-vacuity guard as the nesting scan: a green shape ratchet must be
    // distinguishable from one whose pattern never matches.
    const missing = findShapeViolations(`res.status(404).json({ error: 'not_found' });`, 's.ts');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.reason).toContain('`message` is REQUIRED');

    const extra = findShapeViolations(
      `res.status(429).json({ error: 'rate_limited', message: 'busy', detail: 'x' });`, 's.ts');
    expect(extra).toHaveLength(1);
    expect(extra[0]!.reason).toContain('detail');

    expect(findShapeViolations(
      `res.status(404).json({ error: 'not_found', message: 'gone', details: { a: 1 } });`, 's.ts')).toEqual([]);
  });

  it('the shape scan resolves conditional spreads — in BOTH directions', () => {
    // Without spread resolution the canonical `routes/scheduler.ts` emit reads as
    // a violation (its `details` arrives through a spread) and the `connections`
    // emit that really did put `reason` at the top level reads as clean. Getting
    // this wrong is a false alarm and a miss at the same time.
    expect(findShapeViolations(
      `res.status(c ? 409 : 400).json({ error: e.code, message: e.message, ...(c ? {} : { details: { max: 'P30D' } }) });`,
      's.ts')).toEqual([]);
    const leaked = findShapeViolations(
      `res.status(422).json({ error: 'rejected', message: 'no', ...(o.reason ? { reason: o.reason } : {}) });`,
      's.ts');
    expect(leaked).toHaveLength(1);
    expect(leaked[0]!.reason).toContain('reason');
  });

  it('the exempt marker is honoured, and only where it is written', () => {
    const marked = `// ${EXEMPT_MARKER} a readiness REPORT, not an error envelope\n`
      + `res.status(503).json({ status: 'degraded', error: 'readiness_check_failed' });`;
    expect(findShapeViolations(marked, 's.ts')).toEqual([]);
    const unmarked = `res.status(503).json({ status: 'degraded', error: 'readiness_check_failed' });`;
    expect(findShapeViolations(unmarked, 's.ts')).toHaveLength(1);
  });

  it('the exemption is used sparingly and every marker still guards a real emit', () => {
    // A marker that no longer sits on an emit is dead permission. Count them, and
    // fail if the exemption starts spreading: it is a declaration that a body is
    // not an envelope, not a way to silence the ratchet.
    const marked = walk(SRC)
      .map((f) => [f.slice(SRC.length + 1), readFileSync(f, 'utf8')] as const)
      .filter(([, src]) => src.includes(EXEMPT_MARKER));
    expect(marked.map(([f]) => f)).toEqual(['routes/health.ts']);
    for (const [f, src] of marked) {
      // The marked file must still contain a non-2xx emit — otherwise the marker
      // is stale and should have been deleted with the code it covered.
      const hasEmit = [...src.matchAll(/res\.status\(\s*[45]\d\d\s*\)\s*\.json\(/g)].length > 0;
      expect(hasEmit, `${f} carries the exempt marker but no longer emits a 4xx/5xx body`).toBe(true);
    }
  });

  it('there is exactly ONE envelope emitter — no file re-grows a private `sendError`', () => {
    // The nesting and shape scans both read the EMIT. Neither can see a second
    // EMITTER: `routes/prompts.ts` carried its own `sendError`, same name and
    // same signature, producing a correctly flat envelope while bypassing the
    // credential scrub AND ADR 0143 locale negotiation across 24 sites — one of
    // them interpolating a caller-supplied workspaceId straight into the
    // message. It read as conformant at every call site, and "the host has one
    // emitter" was false the whole time.
    const defs = walk(SRC)
      .map((f) => [f.slice(SRC.length + 1), readFileSync(f, 'utf8')] as const)
      .filter(([, src]) => /function sendError\s*\(/.test(src))
      .map(([f]) => f);
    expect(
      defs,
      'The ONE envelope emitter is `sendError` in src/middleware/errorEnvelope.ts — it scrubs '
        + 'credential-shaped substrings and negotiates the response locale. A second definition '
        + 'emits an envelope that skips both, and shadows the shared one by name.',
    ).toEqual(['middleware/errorEnvelope.ts']);
  });

  it('the scan does NOT flag the four legitimately-nested classes', () => {
    const legitimate = `
      // 1. run-level error on a run snapshot / event payload
      await storage.updateRun(id, { status: 'failed', error: { code: 'approval_rejected', message: 'no' } });
      // 2. a bulk-result item
      results.push({ runId, ok: false, error: { code: 'not_found', message: 'gone' } });
      // 3. a JSON-RPC body (numeric code, carried at HTTP 200 beside jsonrpc + id)
      res.status(200).json({ jsonrpc: '2.0', id: 0, error: { code: -32603, message: 'internal' } });
      // 4a. a 200 result document whose payload happens to be an error object
      res.status(200).json({ error: { code: 'sandbox_timeout', details: { message: 'slow' } } });
      // 4b. a result document carrying error beside other keys
      res.status(403).json({ toolCalled: false, toolReturned: null, error: { code: 'forbidden' } });
      // and the canonical flat emit itself
      res.status(404).json({ error: 'not_found', message: 'gone' });
    `;
    expect(findNestedEnvelopeEmits(legitimate, 'synthetic.ts')).toEqual([]);
  });
});
