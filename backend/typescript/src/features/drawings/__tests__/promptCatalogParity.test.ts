/**
 * XCH-DRAW-1 drift tripwire (LLM-EXCHANGE-AUDIT 2026-07-13): the Illustrator
 * agent prompt hand-carries the drawing shape vocabulary, and it had drifted —
 * `stroke`/`arrow` (ADR 0333 Phases 3–4) never reached the prompt, so the model
 * could not emit two validator-supported primitives. Pin the prompt's "Shape
 * kinds" section to the validator's closed world so the next kind added to
 * DRAWING_SHAPE_KINDS fails CI here instead of silently underselling the model.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { DRAWING_SHAPE_KINDS, validateDrawingDoc } from '../validateDrawingDoc.js';
import { ASSET_SERVE_PATH } from '../../../host/assetServePath.js';

describe('illustrator prompt ↔ validateDrawingDoc shape-kind parity (XCH-DRAW-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/vendor.openwop-app.drawings.agents/prompts/illustrator.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('names every validator kind as a `kind` bullet, and no kind the validator refuses', () => {
    // Read the "Shape kinds" BULLETS, not the whole prompt: the paint field is also
    // written `stroke`, in backticks, so a whole-prompt check could not see the kind go
    // missing, which is the exact XCH-DRAW-1 drift.
    const start = prompt.indexOf('Shape kinds and their geometry');
    expect(start).toBeGreaterThan(-1);
    const section = prompt.slice(start, prompt.indexOf('\n\n', start));
    const bullets = section.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, l.indexOf('{')));
    const kinds = bullets.flatMap((l) => [...l.matchAll(/`([a-z]+)`/g)].map((m) => m[1]));
    expect(kinds.sort()).toEqual([...DRAWING_SHAPE_KINDS].sort());
  });

  it('names the image `src` address the host MINTS — unversioned, from its one owner (ADR 0669)', () => {
    // The prompt taught `/v1/host/…/assets/<token>` for months after the mint
    // stopped producing it. Pin the documented address to `ASSET_SERVE_PATH`
    // so the next change to it fails here, and refuse any versioned spelling:
    // a `/v<N>` address is one the model would be told to write and the host
    // would only honour by redirect after that major retires.
    expect(prompt).toContain(`\`${ASSET_SERVE_PATH}/<token>\``);
    expect(prompt).not.toMatch(new RegExp(`/v[0-9]+${ASSET_SERVE_PATH}`));
  });

  it('documents the arrow head vocabulary', () => {
    expect(prompt).toContain('startHead');
    expect(prompt).toContain('endHead');
    // `HEADS` is not exported, so the validator is the other side of this parity.
    const heads = /`"(\w+)"` or `"(\w+)"`/.exec(prompt)?.slice(1) ?? [];
    expect(heads).toHaveLength(2);
    const arrow = (head: string): Record<string, unknown> => ({ shapes: [{ kind: 'arrow', x1: 0, y1: 0, x2: 9, y2: 9, startHead: head, endHead: head }] });
    for (const head of heads) expect(validateDrawingDoc(arrow(head)).errors, `prompt offers head '${head}'`).toEqual([]);
    expect(validateDrawingDoc(arrow('triangle')).errors.map((e) => e.path).sort()).toEqual(['shapes[0].endHead', 'shapes[0].startHead']);
  });
});
