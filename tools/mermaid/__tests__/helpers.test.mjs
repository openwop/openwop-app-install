/**
 * tools/mermaid/helpers.mjs tests.
 *
 * Pure logic — no filesystem, no browser. Covers the fence-parsing decision
 * branches (heading attribution, nested/non-mermaid fences, unterminated
 * blocks) plus HTML escaping, so a regression surfaces without rendering.
 * Not in `npm run ci`: nothing in the gate reds this file.
 *
 * Escaping is asserted at the HTML layer only (MERMAID-TOOL.md): mermaid reads
 * the text back and renders labels under `securityLevel: 'loose'`, which this
 * file does not cover (MERMAID-LOOSE-1).
 *
 * Sabotage that turns it red (each probed): the closing-fence width, skipping a
 * non-mermaid fence, escaping in any of code, heading or title, the plural.
 *
 * Uses Node's built-in test runner so the repo needs no extra test dependency
 * for tooling. Run with a QUOTED glob so Node expands it, not the shell:
 *
 *     node --test 'tools/mermaid/__tests__/*.test.mjs'
 *
 * The bare-directory form (`node --test tools/mermaid/`) does NOT work on
 * Node 22 — see MERMAID-TOOL.md § Tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHtml, escapeHtml, extractMermaidBlocks } from '../helpers.mjs';

test('extracts a block and labels it with the nearest preceding heading', () => {
  const md = ['# Title', '', '## Market landscape', '', '```mermaid', 'flowchart LR', '  A --> B', '```', ''].join(
    '\n'
  );

  const blocks = extractMermaidBlocks(md);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].heading, 'Market landscape');
  assert.equal(blocks[0].line, 5);
  assert.equal(blocks[0].code, 'flowchart LR\n  A --> B');
});

test('attributes each block to its own most recent heading', () => {
  const md = [
    '## First',
    '```mermaid',
    'flowchart TD',
    '```',
    '### Second',
    '```mermaid',
    'timeline',
    '```',
  ].join('\n');

  assert.deepEqual(
    extractMermaidBlocks(md).map((b) => [b.heading, b.code]),
    [
      ['First', 'flowchart TD'],
      ['Second', 'timeline'],
    ]
  );
});

test('ignores non-mermaid fences entirely', () => {
  const md = ['```js', "const mermaid = 'not a diagram';", '```', '```mermaid', 'flowchart LR', '```'].join('\n');

  const blocks = extractMermaidBlocks(md);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, 'flowchart LR');
});

test('does not treat a mermaid fence nested inside a wider fence as a diagram', () => {
  const md = ['````markdown', '```mermaid', 'flowchart LR', '```', '````'].join('\n');

  assert.deepEqual(extractMermaidBlocks(md), []);

  // A bare inner fence must not close the wider one, or the next block is read as a diagram.
  const wider = ['````markdown', '```', '```mermaid', 'shown', '```', '````', '```mermaid', 'real', '```'].join('\n');
  assert.deepEqual(extractMermaidBlocks(wider).map((b) => b.code), ['real']);
});

test('an unterminated block still yields its body rather than throwing', () => {
  const md = ['## Trailing', '```mermaid', 'flowchart LR', '  A --> B'].join('\n');

  const blocks = extractMermaidBlocks(md);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, 'flowchart LR\n  A --> B');
});

test('returns an empty array when there is nothing to render', () => {
  assert.deepEqual(extractMermaidBlocks('# Just prose\n\nNo diagrams here.'), []);
});

test('escapeHtml neutralizes markup characters', () => {
  assert.equal(escapeHtml('<a href="x">A & B</a>'), '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;');
});

test('buildHtml escapes diagram source so labels cannot inject markup', () => {
  const html = buildHtml({
    title: 'a<b>.md',
    blocks: [{ heading: '<i>H</i>', line: 1, code: 'flowchart LR\n  A["</script><img>"] --> B' }],
    mermaidVersion: '11.15.0',
  });

  assert.ok(!html.includes('<img>'));
  assert.ok(html.includes('&lt;/script&gt;&lt;img&gt;'));
  assert.ok(html.includes('11.15.0'));
  assert.ok(html.includes('1 mermaid diagram ·'));
  assert.ok(!html.includes('<i>'));
  assert.ok(html.includes('&lt;i&gt;H&lt;/i&gt;'));
  assert.ok(!html.includes('a<b>'));
  assert.ok(html.includes('<title>a&lt;b&gt;.md — diagrams</title>'));

  const two = buildHtml({ title: 't', blocks: [{ heading: 'A', line: 1, code: 'a' }, { heading: 'B', line: 2, code: 'b' }], mermaidVersion: '1' });
  assert.ok(two.includes('2 mermaid diagrams ·'));
});
