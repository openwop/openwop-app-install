/**
 * ADR 0624 D2 — the pack↔surface argument-key parity SCANNER (TypeScript
 * compiler API on both sides). The test (`pack-surface-arg-parity.test.ts`)
 * owns the assertions and the docblock; this module owns the population.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '../../..');
const DEFAULT_PACKS = join(REPO, 'packs');
const DEFAULT_FEATURES = join(here, '../src/features');

/** Roots the scan walks — overridable so the test can run the REAL scanner
 *  against a synthetic corpus (the S3 self-test) instead of re-implementing it. */
export interface ScanOptions { packsDir?: string; featuresDir?: string }

// ── Types ───────────────────────────────────────────────────────────────────

export type CallClass = 'literalNoSpread' | 'spread' | 'nonLiteral';
export interface CallSite { pack: string; surfaceId: string; method: string; cls: CallClass; keys: string[]; line: number }
export interface SurfaceMethod { surfaceId: string; method: string; readable: boolean; keys: string[]; file: string }
/** `unread-keys`: a literal×readable pair where the pack sends a key the surface
 *  never reads (the UPWF-1 class). `missing-method`: the pack calls a method NO
 *  bound surface defines — a typo'd method name (review S4; it used to be
 *  counted under the single bound surface and never flagged). */
export type DriftKind = 'unread-keys' | 'missing-method';
export interface Drift { kind: DriftKind; pack: string; surfaceId: string; method: string; sent: string[]; read: string[]; line: number }
export interface Fixture {
  callSites: Record<CallClass, number>;
  methods: { readable: number; opaque: number };
  assertedPairs: number;
  /** `<surfaceId>.<method>` — every opaque method, by NAME (set equality, so a
   *  compensating move — one method turning opaque while another turns readable —
   *  cannot net to zero against the count alone). */
  opaqueMethods: string[];
  /** `<pack>/index.mjs:<line> <cls> → <surfaceId>.<method>` — every spread /
   *  nonLiteral call site the parity assertion does NOT cover, by SITE. */
  excludedCallSites: string[];
  knownDrift: Array<{ kind?: DriftKind; pack: string; surfaceId: string; method: string; sent: string[]; read: string[] }>;
}

// ── Surface side ────────────────────────────────────────────────────────────

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, kind);
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) cur = cur.left;
    else return cur;
  }
}

/** `src/features/<dir>/feature.ts` → `{ id, build, file }` for each registered surface. */
function registeredSurfaces(FEATURES: string): Array<{ id: string; build: string; file: string }> {
  const out: Array<{ id: string; build: string; file: string }> = [];
  for (const dir of readdirSync(FEATURES)) {
    if (!statSync(join(FEATURES, dir)).isDirectory()) continue;
    const featureFile = join(FEATURES, dir, 'feature.ts');
    if (!existsSync(featureFile)) continue;
    const sf = parse(featureFile);
    const imports = new Map<string, string>();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) && ts.isStringLiteral(st.moduleSpecifier)) {
        for (const el of st.importClause.namedBindings.elements) imports.set(el.name.text, st.moduleSpecifier.text);
      }
    }
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText() === 'surface' && ts.isObjectLiteralExpression(n.initializer)) {
        let id = '';
        let build = '';
        for (const p of n.initializer.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          if (p.name.getText() === 'id' && ts.isStringLiteral(p.initializer)) id = p.initializer.text;
          if (p.name.getText() === 'build' && ts.isIdentifier(p.initializer)) build = p.initializer.text;
        }
        if (id && build) {
          const spec = imports.get(build) ?? './surface.js';
          const file = resolve(dirname(featureFile), spec.replace(/\.js$/, '.ts'));
          if (existsSync(file)) out.push({ id, build, file });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Classify one surface method's parameter usage. */
function classifyMethod(fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): { readable: boolean; keys: string[] } {
  const param = fn.parameters[0];
  if (!param) return { readable: true, keys: [] }; // accepts nothing — every sent key is dropped
  if (ts.isObjectBindingPattern(param.name)) {
    const keys = param.name.elements.map((el) => (el.propertyName ?? el.name).getText().replace(/^['"]|['"]$/g, ''));
    if (param.name.elements.some((el) => el.dotDotDotToken)) return { readable: false, keys };
    return { readable: true, keys };
  }
  if (!ts.isIdentifier(param.name)) return { readable: false, keys: [] };
  const argName = param.name.text;
  const keys = new Set<string>();
  let opaque = false;
  const isArgsRef = (e: ts.Expression): boolean => { const u = unwrap(e); return ts.isIdentifier(u) && u.text === argName; };
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === argName && n !== param.name) {
      const p = n.parent;
      // Shadowing declarations / property names are not reads of the param.
      if ((ts.isPropertyAssignment(p) && p.name === n) || (ts.isPropertyAccessExpression(p) && p.name === n)) return;
      // Walk up through `(args ?? {})`, parens, casts to the consuming node.
      let cur: ts.Node = n;
      while (cur.parent && (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isNonNullExpression(cur.parent) || (ts.isBinaryExpression(cur.parent) && cur.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && cur.parent.left === cur))) cur = cur.parent;
      const consumer = cur.parent;
      if (ts.isPropertyAccessExpression(consumer) && consumer.expression === cur) { keys.add(consumer.name.text); return; }
      if (ts.isElementAccessExpression(consumer) && consumer.expression === cur && ts.isStringLiteral(consumer.argumentExpression)) { keys.add(consumer.argumentExpression.text); return; }
      if (ts.isVariableDeclaration(consumer) && consumer.initializer === cur && ts.isObjectBindingPattern(consumer.name)) {
        if (consumer.name.elements.some((el) => el.dotDotDotToken)) { opaque = true; return; }
        for (const el of consumer.name.elements) keys.add((el.propertyName ?? el.name).getText().replace(/^['"]|['"]$/g, ''));
        return;
      }
      // `typeof args`, `args === undefined`, `!args` guards are not key reads.
      if (ts.isTypeOfExpression(consumer) || ts.isPrefixUnaryExpression(consumer)) return;
      if (ts.isBinaryExpression(consumer) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(consumer.operatorToken.kind)) return;
      opaque = true; // passed whole, spread, returned, … — the reader cannot be named
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  void isArgsRef;
  return { readable: !opaque, keys: [...keys] };
}

function surfaceMethods(surfaces: ReturnType<typeof registeredSurfaces>): SurfaceMethod[] {
  const out: SurfaceMethod[] = [];
  for (const s of surfaces) {
    const sf = parse(s.file);
    let builder: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === s.build) builder = st;
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === s.build) builder = d;
    }
    if (!builder) continue;
    const returns: ts.ObjectLiteralExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) { const u = unwrap(n.expression); if (ts.isObjectLiteralExpression(u)) returns.push(u); }
      if (ts.isArrowFunction(n) && n.body && !ts.isBlock(n.body)) { const u = unwrap(n.body); if (ts.isObjectLiteralExpression(u)) returns.push(u); }
      ts.forEachChild(n, visit);
    };
    visit(builder);
    // The OUTERMOST returned literal is the surface (nested arrows return payloads).
    const surfaceLiteral = returns.find((r) => r.properties.some((p) => ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) && r.properties.some((p) => (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) || ts.isMethodDeclaration(p)));
    if (!surfaceLiteral) continue;
    for (const p of surfaceLiteral.properties) {
      const name = p.name?.getText().replace(/^['"]|['"]$/g, '') ?? '';
      if (!name) continue;
      if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
        out.push({ surfaceId: s.id, method: name, file: s.file, ...classifyMethod(p.initializer) });
      } else if (ts.isMethodDeclaration(p)) {
        out.push({ surfaceId: s.id, method: name, file: s.file, ...classifyMethod(p) });
      } else {
        out.push({ surfaceId: s.id, method: name, file: s.file, readable: false, keys: [] }); // shorthand / computed — defined elsewhere
      }
    }
  }
  return out;
}

// ── Pack side ───────────────────────────────────────────────────────────────

function packCallSites(PACKS: string, surfaceIds: Set<string>, methodsBySurface: Map<string, Set<string>>): CallSite[] {
  const out: CallSite[] = [];
  for (const pack of readdirSync(PACKS)) {
    if (!/^feature\..+\.nodes$/.test(pack)) continue;
    const entry = join(PACKS, pack, 'index.mjs');
    if (!existsSync(entry) || !statSync(entry).isFile()) continue;
    const sf = parse(entry);
    const text = sf.getFullText();
    // 1) surfaces the pack names
    const bound = new Set<string>();
    const slug = pack.replace(/^feature\./, '').replace(/\.nodes$/, '');
    if (surfaceIds.has(slug)) bound.add(slug);
    for (const m of text.matchAll(/features\.([A-Za-z_$][\w$-]*)/g)) if (surfaceIds.has(m[1]!)) bound.add(m[1]!);
    for (const m of text.matchAll(/features\[\s*['"]([^'"]+)['"]\s*\]/g)) if (surfaceIds.has(m[1]!)) bound.add(m[1]!);
    for (const m of text.matchAll(/ensure\w*\(\s*ctx\s*,\s*['"]([^'"]+)['"]/g)) if (surfaceIds.has(m[1]!)) bound.add(m[1]!);
    if (bound.size === 0) continue;
    // 2) resolvable receivers: local consts initialised from ctx.features… / ensure…(
    const receivers = new Set<string>();
    const collectReceivers = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = n.initializer.getText();
        if (/ctx\.features|features\[|ensure\w*\(/.test(init)) {
          if (ts.isIdentifier(n.name)) receivers.add(n.name.text);
          if (ts.isObjectBindingPattern(n.name)) for (const el of n.name.elements) if (ts.isIdentifier(el.name)) receivers.add(el.name.text);
        }
      }
      ts.forEachChild(n, collectReceivers);
    };
    collectReceivers(sf);
    // 3) call sites
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const recv = unwrap(n.expression.expression);
        const recvText = recv.getText();
        const viaChain = /(^|\.)features(\.[\w$-]+|\[['"][^'"]+['"]\])$/.test(recvText);
        const viaLocal = ts.isIdentifier(recv) && receivers.has(recv.text);
        if (viaChain || viaLocal) {
          // Resolve by method ownership; a pack bound to ONE surface attributes an
          // unknown method to it so `scan()` can flag it as `missing-method`
          // (rather than silently dropping the site from the population).
          const surfaceId = [...bound].find((id) => methodsBySurface.get(id)?.has(method)) ?? (bound.size === 1 ? [...bound][0]! : '');
          if (surfaceId) {
            const arg = n.arguments[0];
            const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
            if (!arg) out.push({ pack, surfaceId, method, cls: 'literalNoSpread', keys: [], line });
            else {
              const u = unwrap(arg);
              if (ts.isObjectLiteralExpression(u)) {
                const spread = u.properties.some((p) => ts.isSpreadAssignment(p));
                const keys = u.properties.map((p) => (ts.isSpreadAssignment(p) ? '' : (p.name?.getText().replace(/^['"]|['"]$/g, '') ?? ''))).filter(Boolean);
                out.push({ pack, surfaceId, method, cls: spread ? 'spread' : 'literalNoSpread', keys, line });
              } else out.push({ pack, surfaceId, method, cls: 'nonLiteral', keys: [], line });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ── Scan ────────────────────────────────────────────────────────────────────

export function scan(opts: ScanOptions = {}): { surfaces: number; methods: SurfaceMethod[]; calls: CallSite[]; drift: Drift[]; assertedPairs: number } {
  const surfaces = registeredSurfaces(opts.featuresDir ?? DEFAULT_FEATURES);
  const methods = surfaceMethods(surfaces);
  const methodsBySurface = new Map<string, Set<string>>();
  for (const m of methods) { if (!methodsBySurface.has(m.surfaceId)) methodsBySurface.set(m.surfaceId, new Set()); methodsBySurface.get(m.surfaceId)!.add(m.method); }
  const calls = packCallSites(opts.packsDir ?? DEFAULT_PACKS, new Set(surfaces.map((s) => s.id)), methodsBySurface);
  const drift: Drift[] = [];
  let assertedPairs = 0;
  for (const c of calls) {
    const m = methods.find((x) => x.surfaceId === c.surfaceId && x.method === c.method);
    // S4 — a method NO bound surface defines is drift in every call class: the
    // call throws `… is not a function` at run time, and a typo used to be
    // attributed to the single bound surface and then skipped here.
    if (!m) { drift.push({ kind: 'missing-method', pack: c.pack, surfaceId: c.surfaceId, method: c.method, sent: c.keys, read: [], line: c.line }); continue; }
    if (c.cls !== 'literalNoSpread' || !m.readable) continue;
    assertedPairs += 1;
    const read = new Set(m.keys);
    const unread = c.keys.filter((k) => !read.has(k));
    if (unread.length > 0) drift.push({ kind: 'unread-keys', pack: c.pack, surfaceId: c.surfaceId, method: c.method, sent: c.keys, read: m.keys, line: c.line });
  }
  return { surfaces: surfaces.length, methods, calls, drift, assertedPairs };
}

/** The fixture's per-name / per-site identities (shared by the test's assertion
 *  and its `PACK_SURFACE_PARITY_WRITE=1` regeneration path). */
export const opaqueMethodId = (m: SurfaceMethod): string => `${m.surfaceId}.${m.method}`;
export const excludedCallSiteId = (c: CallSite): string => `${c.pack}/index.mjs:${c.line} ${c.cls} → ${c.surfaceId}.${c.method}`;
