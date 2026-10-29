/**
 * TOC2CD-14 — no provider tool dispatcher may hand a THROWN `onToolUse` error to the
 * model unfenced.
 *
 * Keyed on SHAPE, not on a list of file names: every file under `src/providers/`
 * that drives a tool loop (mentions `onToolUse`) is scanned, and inside each
 * `catch (e)` an `isError: true` object whose `content` mentions `e` must be built
 * by `fenceThrownToolError(...)` (the import-free leaf in untrustedContent.ts) or by
 * `toModelToolResult(...)` with `{ fromThrow: true }`. A new dispatcher file is
 * in the population the moment it calls `onToolUse`, so it cannot be added unfenced.
 *
 * Sabotage witnessed 2026-10-28: restoring the raw `tool_dispatch_failed:
 * ${err.message}` in either dispatcher reds "every dispatcher catch is fenced".
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROVIDERS = join(process.cwd(), 'src', 'providers');

function scan(files: ReadonlyArray<{ file: string; text: string }>): { dispatchers: string[]; checked: number; failures: string[] } {
  const dispatchers: string[] = [];
  let checked = 0;
  const failures: string[] = [];
  for (const { file, text } of files) {
    if (!text.includes('onToolUse')) continue;
    dispatchers.push(file);
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
              const fenced = ts.isCallExpression(init) && ts.isIdentifier(init.expression)
                && (init.expression.text === 'fenceThrownToolError'
                  || (init.expression.text === 'toModelToolResult' && /fromThrow:\s*true/.test(init.getText())));
              if (!fenced) failures.push(`${file}:${sf.getLineAndCharacterOfPosition(m.getStart()).line + 1}`);
            }
          }
          m.forEachChild((c) => { inner.push(c); });
        }
      }
      n.forEachChild((c) => { stack.push(c); });
    }
  }
  return { dispatchers, checked, failures };
}

const SOURCES = readdirSync(PROVIDERS).filter((f) => f.endsWith('.ts')).map((f) => ({ file: `providers/${f}`, text: readFileSync(join(PROVIDERS, f), 'utf8') }));
const result = scan(SOURCES);

describe('TOC2CD-14 — every provider dispatcher fences a thrown onToolUse error', () => {
  it('found the dispatchers and their catches (anti-vacuity)', () => {
    expect(result.dispatchers).toEqual(expect.arrayContaining(['providers/dispatchAnthropicTools.ts', 'providers/dispatchMiniMaxTools.ts']));
    expect(result.checked).toBeGreaterThanOrEqual(2);
  });

  it('every dispatcher catch is fenced', () => {
    expect(result.failures, 'Build the content with fenceThrownToolError(name, text, code).').toEqual([]);
  });

  it('SABOTAGE CONTROL — a new dispatcher with a raw catch is refused', () => {
    const planted = scan([{
      file: 'providers/dispatchPlanted.ts',
      text: 'try { r = await req.onToolUse(x); } catch (err) { r = { toolUseId: x.id, content: `tool_dispatch_failed: ${String(err)}`, isError: true }; }',
    }]);
    expect(planted.dispatchers).toEqual(['providers/dispatchPlanted.ts']);
    expect(planted.failures).toEqual(['providers/dispatchPlanted.ts:1']);
  });

  it('no provider module imports the heavy tool-result graph (train 142 red)', () => {
    // `providers/` importing `host/toModelToolResult.js` dragged `agentToolProvider`'s
    // whole graph into every provider import, and a test's
    // `vi.mock('../src/providers/managedProvider.js', importOriginal)` factory then
    // loaded the real background callers before the mock existed (adr0721 /
    // adr0821-d5 went red only at the train tree). The dispatchers use the
    // import-free leaf `fenceThrownToolError` (host/untrustedContent.ts) instead.
    const offenders = SOURCES
      .filter((s) => /from '\.\.\/host\/(toModelToolResult|agentToolProvider)\.js'/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});

