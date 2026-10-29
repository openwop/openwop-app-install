/**
 * TOC2CD-14 — no catch block may hand a caught error's text
 * to a model as an error result without the thrown-error fence.
 *
 * The provider dispatchers proved a population ratchet keyed on a seam's NAME is not
 * enough: they caught a throw from `onToolUse` and wrote `tool_dispatch_failed:
 * ${err.message}` straight into the model's tool result, from a file no fence ratchet
 * listed. So this keys on the SHAPE, across all of `src`: inside a `catch (e)`, an
 * object literal with `isError: true` whose `content` mentions `e` must either
 *  - build `content` with `toModelToolResult(…, { fromThrow: true })`, or
 *  - carry `fromThrow: true`, so `toModelToolResult` fences it,
 * unless the site is listed in NOT_MODEL_FACING with its reason.
 *
 * Sabotage witnessed 2026-10-28: restoring either dispatcher's raw template reds
 * "every catch-built error result is fenced"; so does dropping `fromThrow: true` from
 * any of the five returned-error sites.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');
const FENCE_CALLS = new Set(['toModelToolResult', 'fenceThrownToolError']);

/** file → why its catch-built error object never reaches a model as written. */
const NOT_MODEL_FACING: Record<string, string> = {
  'host/evals/toolBoundary.ts':
    'ADR 0889 D9 — records what the dispatcher answered for an eval case\'s as-executed log; the live result returns to the loop unchanged and is fenced there.',
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    if (statSync(f).isDirectory()) return e === '__tests__' ? [] : walk(f);
    return f.endsWith('.ts') ? [f] : [];
  });
}

function scan(files: ReadonlyArray<{ file: string; text: string }>): { checked: number; failures: string[] } {
  let checked = 0;
  const failures: string[] = [];
  for (const { file, text } of files) {
    if (!text.includes('catch') || !text.includes('isError')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const n = stack.pop()!;
      if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
        const caught = new RegExp(`\\b${n.variableDeclaration.name.text}\\b`);
        const inner: ts.Node[] = [n.block];
        while (inner.length) {
          const m = inner.pop()!;
          if (ts.isObjectLiteralExpression(m)) {
            const prop = (name: string) => m.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) as ts.PropertyAssignment | undefined;
            const isErr = prop('isError');
            const content = prop('content');
            if (isErr && isErr.initializer.getText() === 'true' && content && caught.test(content.initializer.getText())) {
              checked += 1;
              const init = content.initializer;
              const fenceCall = ts.isCallExpression(init) && ts.isIdentifier(init.expression) && FENCE_CALLS.has(init.expression.text);
              const fromThrow = prop('fromThrow')?.initializer.getText() === 'true';
              if (!fenceCall && !fromThrow && !NOT_MODEL_FACING[file]) {
                failures.push(`${file}:${sf.getLineAndCharacterOfPosition(m.getStart()).line + 1}  ${init.getText().replace(/\s+/g, ' ').slice(0, 100)}`);
              }
            }
          }
          m.forEachChild((c) => { inner.push(c); });
        }
      }
      n.forEachChild((c) => { stack.push(c); });
    }
  }
  return { checked, failures };
}

const SOURCES = walk(SRC).map((f) => ({ file: relative(SRC, f), text: readFileSync(f, 'utf8') }));
const result = scan(SOURCES);

describe('TOC2CD-11 — a caught error never reaches a model as an unfenced error result', () => {
  it('found the catch-built error results at all (anti-vacuity)', () => {
    // MEASURED 2026-10-28 on main: the two provider dispatchers, the two tool-loop
    // catches, five returned-error sites and the eval recorder.
    expect(result.checked).toBeGreaterThanOrEqual(10);
  });

  it('every catch-built error result is fenced', () => {
    expect(result.failures, 'Build the content with toModelToolResult(…, true, { fromThrow: true }) or add `fromThrow: true`.').toEqual([]);
  });

  it('every NOT_MODEL_FACING row still names a live file', () => {
    for (const file of Object.keys(NOT_MODEL_FACING)) expect(SOURCES.some((s) => s.file === file), file).toBe(true);
  });

  it('SABOTAGE CONTROL — a new dispatcher-style catch is refused', () => {
    const planted = scan([{
      file: 'providers/dispatchPlanted.ts',
      text: [
        'try { r = await req.onToolUse(x); } catch (err) {',
        '  r = { toolUseId: x.id, content: `tool_dispatch_failed: ${String(err)}`, isError: true };',
        '}',
        'try { r = await run(); } catch (e) { r = { content: toModelToolResult(n, String(e), true, { fromThrow: true }), isError: true }; }',
        'try { r = await run(); } catch (e) { r = { content: String(e), isError: true, fromThrow: true }; }',
      ].join('\n'),
    }]);
    expect(planted.checked).toBe(3);
    expect(planted.failures).toEqual(['providers/dispatchPlanted.ts:2  `tool_dispatch_failed: ${String(err)}`']);
  });
});
