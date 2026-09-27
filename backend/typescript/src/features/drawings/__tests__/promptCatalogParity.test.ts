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
import { DRAWING_SHAPE_KINDS } from '../validateDrawingDoc.js';

describe('illustrator prompt ↔ validateDrawingDoc shape-kind parity (XCH-DRAW-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/feature.drawings.agents/prompts/illustrator.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('names every validator kind as a `kind` bullet', () => {
    for (const kind of DRAWING_SHAPE_KINDS) {
      // Kinds are documented as backtick-quoted bullets; `stroke` alone would
      // false-positive on the paint field, so require the quoted-token form.
      expect(prompt, `prompt must document shape kind '${kind}'`).toContain(`\`${kind}\``);
    }
  });

  it('documents the arrow head vocabulary', () => {
    expect(prompt).toContain('startHead');
    expect(prompt).toContain('endHead');
  });
});
