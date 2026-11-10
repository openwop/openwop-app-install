/**
 * #5422 — the one stripper keeps every line of live code and removes every comment.
 *
 * The regex it replaced ran from a `/*` in a line comment or a string to the next
 * star-slash, even one in a string, and took the code between. That left a ratchet
 * blind to 1,283 lines of `routes/testSeam.ts`. Red under: restoring either regex
 * order in the helper, dropping the regex rescan, making a `/` after an expression
 * open a regex (`a / b; // c / d` would keep its comment), dropping the template-hole
 * tracking, or dropping a block comment's newlines (line numbers move).
 *
 * The template fixture must not self-heal: in `${ … `n${y}` … }b /* kept *\/`` an
 * untracked hole re-pairs its backticks and copies the same text, so it cannot tell
 * the two scanners apart (w83 probe). `${x}/* kept *\/` then a line comment can.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/stripComments.js';

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('stripComments', () => {
  it('a /* in a line comment or a string opens nothing', () => {
    expect(stripComments("// a /v1/x/* path\nconst a = 1;\nconst b = '*/';\n")).toBe(" \nconst a = 1;\nconst b = '*/';\n");
    expect(stripComments("const g = '/*'; const h = 1; /* c */ const i = '*/';")).toBe("const g = '/*'; const h = 1;   const i = '*/';");
  });

  it('removes comments in code and in template holes, and copies the literals', () => {
    expect(stripComments('const a = /\\/\\//.test(s); // tail\n')).toBe('const a = /\\/\\//.test(s);  \n');
    expect(stripComments('const q = a / b / c; // tail\n')).toBe('const q = a / b / c;  \n');
    // A `/` after an expression divides; read as a regex, `/ b; /` would swallow the `//`.
    expect(stripComments('const r = a / b; // c / d\n')).toBe('const r = a / b;  \n');
    const t = stripComments('const t = `a${ /* in */ x ? `n${y}` : "z" }b /* kept */`;');
    expect(t).not.toContain('in */');
    expect(t).toContain('b /* kept */`');
    // A hole's closing brace resumes the template, so its tail is copied, and the
    // line comment after the template is code again.
    expect(stripComments('const u = `${x}/* kept */`; // gone\n')).toBe('const u = `${x}/* kept */`;  \n');
  });

  it('keeps line numbers', () => {
    expect(stripComments('/* a\n b\n c */\nconst x = 1;').split('\n')[3]).toBe('const x = 1;');
  });

  it('keeps the live code a regex stripper lost in testSeam.ts', () => {
    const src = readFileSync('src/routes/testSeam.ts', 'utf8');
    expect(src, 'the fixture must still carry the trap').toMatch(/\/\/[^\n]*\/\*/);
    expect(stripComments(src)).toMatch(/\.insertRun\s*\(/);
  });

  it('no test hand-rolls the regex that hid live code', () => {
    const IDIOM = ['.replace(/', String.raw`\/\*[\s\S]*?\*\/`].join('');
    const offenders = testFiles('test').filter((f) => readFileSync(f, 'utf8').includes(IDIOM));
    expect(offenders).toEqual([]);
  });
});
