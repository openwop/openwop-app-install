/**
 * TOC2CD-11 — the AST ratchet behind "fence by PROVENANCE, not by tool trust".
 *
 * A tool's returned error reaches the model OUTSIDE the untrusted fence only when
 * the result carries `hostMessage: true`, which only a `toolError` helper sets. So
 * the `message` of every `toolError(...)` call (and of every helper that forwards
 * a message into one — the SINKS below) must be a HOST-AUTHORED sentence. This
 * file classifies each such argument by its AST, never by matching identifiers:
 *
 *  - a string literal, a template literal with no `${}` → host;
 *  - a template literal / `+` concatenation / `?:` → host iff EVERY operand is;
 *  - `x.length` (a count), an UPPER_SNAKE constant, `CONST.join('<literal>')` → host;
 *  - a reviewed operand in HOST_OPERANDS for that file (with its reason) → host;
 *  - ANYTHING else — `err.message`, a response body, a model- or user-supplied id
 *    or name, a call, an identifier nobody reviewed — FAILS (fail closed).
 *
 * A failing site is fixed by writing a host sentence, or by calling
 * `untrustedToolError(...)` (`host/agentToolKit.ts`), which sets no flag, so its
 * text is fenced. Also enforced: nothing but a `toolError` helper sets
 * `hostMessage: true`.
 *
 * Sabotage witnessed 2026-10-28: a `toolError('x', \`${err.message}\`)` and a
 * `toolError('x', 'x' + body)` each red "every message sink is host-authored".
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** Calls whose argument at `arg` becomes a host-authored error message. */
const CALL_SINKS: ReadonlyArray<{ callee: string; arg: number; files?: readonly string[] }> = [
  { callee: 'toolError', arg: 1 },
  // `untrustedToolError(code, message, detail?, extra?)`: `message` is still a host
  // sentence read OUTSIDE the fence; only `detail` (arg 2) is fenced.
  { callee: 'untrustedToolError', arg: 1 },
  { callee: 'featureUnavailable', arg: 1 },
  { callee: 'toolFailLog', arg: 3 },
  // A local `deny(error, message)` wrapper over `toolError` in these three files only
  // (other files have unrelated functions of that name).
  { callee: 'deny', arg: 1, files: ['features/discovery/agentTools.ts', 'features/promotions/agentTools.ts', 'features/recommendations/agentTools.ts'] },
  { callee: 'schedulingRefusal', arg: 1 },
  { callee: 'resolveDocumentsReadContext', arg: 2 },
  { callee: 'resolveDocumentsGetPreamble', arg: 1 },
  // campaign-intel `positiveInt(v, field)` — `field` is interpolated into its message.
  { callee: 'positiveInt', arg: 1, files: ['features/campaign-intel/agentTools.ts'] },
  // kicktodo-creator `intakeInt(raw, bounds, name)` — both feed its validation message.
  { callee: 'intakeInt', arg: 1, files: ['features/kicktodo-creator/agentTools.ts'] },
  { callee: 'intakeInt', arg: 2, files: ['features/kicktodo-creator/agentTools.ts'] },
];
/** The helpers allowed to set `hostMessage: true` on a result. */
const FLAG_SETTERS = new Set(['toolError', 'untrustedToolError']);
/** Object properties whose value becomes a host-authored message (`featureUnavailable(…, opts.featureLabel)`). */
const PROP_SINKS = new Set(['featureLabel']);

const SINK_PARAM = 'a parameter of a sink helper: every caller\'s argument is itself classified above';

/** Reviewed non-literal operands, per file, with the reason each is host-only. */
const HOST_OPERANDS: Record<string, Record<string, string>> = {
  'host/agentToolKit.ts': {
    featureLabel: SINK_PARAM,
    'opts.featureLabel': SINK_PARAM,
    "toolFailLog#message ?? 'The tool failed to complete. Try again or narrow the request.'": SINK_PARAM,
  },
  'host/agentToolProvider.ts': {
    featureId: '`computeNodeOwningFeature(typeId)` — a host feature id from a static typeId map',
  },
  'features/scheduled-agent-chats/agentTools.ts': { noun: SINK_PARAM },
  'features/documents/agentTools.ts': { actingUserRefusal: SINK_PARAM },
  'features/discovery/agentTools.ts': { 'deny#message': SINK_PARAM, required: 'a `Scope` union member chosen by the host from the mode' },
  'features/promotions/agentTools.ts': { 'deny#message': SINK_PARAM, required: 'a `Scope` union member chosen by the host from the mode' },
  'features/recommendations/agentTools.ts': { 'deny#message': SINK_PARAM, required: 'a `Scope` union member chosen by the host from the mode' },
  'features/cms/agentTools.ts': { "grant.locales.join(', ')": 'locales an admin granted, each validated against LOCALE_RE on write' },
  'features/funnels/agentTools.ts': { 'existing.status': 'a stored funnel status — the closed FunnelStatus union' },
  'features/kicktodo-creator/agentTools.ts': {
    'intakeInt#name': SINK_PARAM,
    'intakeInt#bounds.min': 'a field of `intakeInt`\'s `bounds` parameter, itself a classified sink (an UPPER_SNAKE plan-validator constant)',
    'intakeInt#bounds.max': 'a field of `intakeInt`\'s `bounds` parameter, itself a classified sink (an UPPER_SNAKE plan-validator constant)',
  },
  'features/campaign-intel/agentTools.ts': { 'positiveInt#field': SINK_PARAM },
  'features/app-builder/agentTools.ts': {
    'result.message': '`renderAppBuilder` (renderCore.ts) — its literal repair sentences ("read it with the get-design tool first") and the app-builder surface\'s own OpenwopError text; 14\'s decision 2026-10-28: host repair text stays outside the fence',
  },
  'features/campaign-studio/agentTools.ts': {
    'result.message': 'the campaign render core — its literal repair sentences and the surface\'s own OpenwopError text; 14\'s decision 2026-10-28: host repair text stays outside the fence',
  },
  'features/email/agentTools.ts': { 'campaign.status': 'a stored email campaign status — the closed campaign-status union' },
};

const UPPER = /^[A-Z][A-Z0-9_]*$/;

/** 14's decision (2026-10-28): in these files, the `message` of an `OpenwopError` the
 *  file's own services threw is host-authored service text, read OUTSIDE the fence.
 *  Recognised only under an `if (x instanceof OpenwopError)` guard on the same `x`. */
const OPENWOP_MESSAGE_FILES = new Set([
  'features/cms/agentTools.ts', 'features/comments/agentTools.ts', 'features/crm/agentTools.ts',
  'features/csm/agentTools.ts', 'features/funnels/agentTools.ts', 'features/workflow-author/agentTools.ts',
]);

/** `x.message` inside the then-branch of `if (x instanceof OpenwopError)` (alone or in an `&&`). */
function isGuardedOpenwopMessage(e: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'message' || !ts.isIdentifier(e.expression)) return false;
  const guard = new RegExp(`(^|&&\\s*)${e.expression.text} instanceof OpenwopError(\\s*&&|$)`);
  for (let child: ts.Node = e, p: ts.Node | undefined = e.parent; p; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && p.thenStatement === child && guard.test(p.expression.getText().trim())) return true;
  }
  return false;
}

/** The name of the function (declaration, or arrow/function bound to a const) enclosing `n`. */
function enclosingFn(n: ts.Node): string | undefined {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return undefined;
}

function isHost(e: ts.Expression, file: string, bad: string[]): boolean {
  // A reviewed operand: file-wide (`expr`) or only inside one function (`fn#expr`,
  // review L2 — a pass-through `message` parameter must not exempt every `message`).
  const ops = HOST_OPERANDS[file];
  if (ops && (ops[e.getText()] || ops[`${enclosingFn(e) ?? ''}#${e.getText()}`])) return true;
  if (OPENWOP_MESSAGE_FILES.has(file) && isGuardedOpenwopMessage(e)) return true;
  if (ts.isParenthesizedExpression(e)) return isHost(e.expression, file, bad);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return true;
  if (ts.isTemplateExpression(e)) {
    let ok = true;
    for (const span of e.templateSpans) ok = isHost(span.expression, file, bad) && ok;
    return ok;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = isHost(e.left, file, bad);
    const r = isHost(e.right, file, bad);
    return l && r;
  }
  if (ts.isConditionalExpression(e)) {
    const a = isHost(e.whenTrue, file, bad);
    const b = isHost(e.whenFalse, file, bad);
    return a && b;
  }
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'length') return true;
  if (ts.isIdentifier(e) && UPPER.test(e.text)) return true;
  if (
    ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'join'
    && ts.isIdentifier(e.expression.expression) && UPPER.test(e.expression.expression.text)
    && e.arguments.every((a) => ts.isStringLiteral(a))
  ) return true;
  bad.push(e.getText().split('\n')[0]!);
  return false;
}

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    if (statSync(f).isDirectory()) return e === '__tests__' ? [] : walk(f);
    return f.endsWith('.ts') ? [f] : [];
  });
}

interface Finding { at: string; operands: string[] }

/** Classify every sink in the given sources. Exported shape kept local; the sabotage
 *  case below feeds it synthetic source. */
function scan(files: ReadonlyArray<{ file: string; text: string }>): { sinks: number; failures: Finding[]; flagSetters: string[] } {
  let sinks = 0;
  const failures: Finding[] = [];
  const flagSetters: string[] = [];
  for (const { file, text } of files) {
    // Cheap pre-filter: a file naming no sink and no flag cannot hold one.
    if (!CALL_SINKS.some((c) => text.includes(`${c.callee}(`)) && !text.includes('featureLabel') && !text.includes('hostMessage')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    // Iterative, not recursive: some generated sources nest deep enough to blow the stack.
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const n = stack.pop()!;
      const at = (): string => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      // A sink called by name, or as a property (`kit.toolError(...)`, review M5).
      if (ts.isCallExpression(n)) {
        const calleeName = ts.isIdentifier(n.expression) ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : undefined;
        // EVERY sink row for this callee (a helper can carry more than one message argument).
        const matched = calleeName ? CALL_SINKS.filter((c) => c.callee === calleeName && (!c.files || c.files.includes(file))) : [];
        for (const sink of matched) {
          sinks += 1;
          const arg = n.arguments[sink.arg];
          const bad: string[] = [];
          // A spread argument or a missing message cannot be classified: fail closed.
          if (n.arguments.some((a) => ts.isSpreadElement(a))) bad.push('<spread argument>');
          else if (!arg) { if (sink.callee === 'toolError' || sink.callee === 'untrustedToolError') bad.push('<missing message>'); }
          else isHost(arg, file, bad);
          if (bad.length) failures.push({ at: at(), operands: bad });
        }
      }
      // A flag-setter helper renamed on import or aliased cannot be followed (M5).
      if (ts.isImportSpecifier(n) && FLAG_SETTERS.has((n.propertyName ?? n.name).text) && n.propertyName) {
        failures.push({ at: at(), operands: [`<import rename ${n.propertyName.text} as ${n.name.text}>`] });
      }
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && FLAG_SETTERS.has(n.initializer.text)) {
        failures.push({ at: at(), operands: [`<alias of ${n.initializer.text}>`] });
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && PROP_SINKS.has(n.name.text)) {
        sinks += 1;
        const bad: string[] = [];
        if (!isHost(n.initializer, file, bad)) failures.push({ at: at(), operands: bad });
      }
      // `hostMessage` set ANY way (review M4): `hostMessage: x`, `'hostMessage': x`,
      // `['hostMessage']: x`, shorthand `{ hostMessage }`, or `r.hostMessage = x`.
      const setsFlag =
        ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n))
          && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'hostMessage')
        || (ts.isPropertyAssignment(n) && ts.isComputedPropertyName(n.name)
          && ts.isStringLiteral(n.name.expression) && n.name.expression.text === 'hostMessage')
        || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'hostMessage');
      if (setsFlag && !FLAG_SETTERS.has(enclosingFn(n) ?? '')) flagSetters.push(at());
      // A vouched result whose payload is swapped: `{ ...toolError(...), content: x }`.
      if (ts.isObjectLiteralExpression(n)
        && n.properties.some((p) => ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression)
          && ts.isIdentifier(p.expression.expression) && FLAG_SETTERS.has(p.expression.expression.text))
        && n.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && ts.isIdentifier(p.name) && p.name.text === 'content')) {
        flagSetters.push(at());
      }
      n.forEachChild((c) => { stack.push(c); });
    }
  }
  return { sinks, failures, flagSetters };
}

const SOURCES = walk(SRC).map((f) => ({ file: relative(SRC, f), text: readFileSync(f, 'utf8') }));
const result = scan(SOURCES);

describe('TOC2CD-11 — a host-unfenced error message is host-authored, by AST', () => {
  it('found the sinks at all (anti-vacuity)', () => {
    // MEASURED 414 on the TOC2CD-11 branch (2026-10-28), after 74 non-host sites moved to
    // `untrustedToolError`. A floor that lags the population lets a deletion pass unseen.
    expect(result.sinks).toBeGreaterThanOrEqual(414);
  });

  it('every message sink is host-authored', () => {
    expect(
      result.failures.map((f) => `${f.at}  ${f.operands.join(' | ')}`),
      'An error message reaching the model OUTSIDE the fence is built from text the host did not write. '
        + 'Write a host sentence, or call `untrustedToolError(...)` (agentToolKit) so it is fenced. '
        + 'Add to HOST_OPERANDS only an operand that is provably host-only, with the reason.',
    ).toEqual([]);
  });

  it('only a toolError / untrustedToolError helper sets `hostMessage`', () => {
    expect(result.flagSetters).toEqual([]);
  });

  it('every HOST_OPERANDS entry is still used (no stale exemption)', () => {
    for (const [file, ops] of Object.entries(HOST_OPERANDS)) {
      const text = SOURCES.find((s) => s.file === file)?.text ?? '';
      for (const op of Object.keys(ops)) expect(text, `${file}: ${op}`).toContain(op.includes('#') ? op.slice(op.indexOf('#') + 1) : op);
    }
  });

  it('SABOTAGE CONTROL — `${err.message}` and `\'x\' + body` are refused, an unknown identifier too', () => {
    const planted = scan([{
      file: 'features/planted/agentTools.ts',
      text: [
        "const a = toolError('x', `failed: ${err.message}`);",
        "const b = toolError('x', 'x' + body);",
        "const c = toolError('x', someName);",
        "const d = toolError('x', `ok ${items.length} rows, ${MAX_ROWS} max`);",
        "const e = { hostMessage: true };",
        "const f = kit.toolError('x', reason);",
        "const g = toolError('x', ...args);",
        "const h = { hostMessage };",
        "r.hostMessage = true;",
        "const i = { ...toolError('x', 'ok'), content: upstream };",
        "const te = toolError;",
        "import { toolError as fail } from './kit.js';",
        "const j = untrustedToolError('x', `bad ${err.message}`, err.message);",
      ].join('\n'),
    }]);
    expect(planted.failures.map((f) => f.operands.join('|')).sort()).toEqual([
      '<alias of toolError>', '<import rename toolError as fail>', '<spread argument>',
      'body', 'err.message', 'err.message', 'reason', 'someName',
    ]);
    expect(planted.flagSetters.sort()).toEqual([
      'features/planted/agentTools.ts:10', 'features/planted/agentTools.ts:5',
      'features/planted/agentTools.ts:8', 'features/planted/agentTools.ts:9',
    ]);
  });

  it('the OpenwopError rule is narrow: listed file, same variable, then-branch only', () => {
    const src = [
      'if (err instanceof OpenwopError) return toolError(err.code, err.message);',
      'if (other instanceof OpenwopError) return toolError(\'x\', err.message);',
      'if (err instanceof OpenwopError) { x(); } else { return toolError(\'x\', err.message); }',
    ].join('\n');
    const listed = scan([{ file: 'features/crm/agentTools.ts', text: src }]);
    expect(listed.failures.map((f) => f.at).sort()).toEqual(['features/crm/agentTools.ts:2', 'features/crm/agentTools.ts:3']);
    const unlisted = scan([{ file: 'features/planted/agentTools.ts', text: src }]);
    expect(unlisted.failures).toHaveLength(3);
  });
});
