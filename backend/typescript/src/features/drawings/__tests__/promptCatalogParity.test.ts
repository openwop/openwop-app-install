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
import { ASSET_SERVE_PATH } from '../../../host/assetServePath.js';

describe('illustrator prompt ↔ validateDrawingDoc shape-kind parity (XCH-DRAW-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/vendor.openwop-app.drawings.agents/prompts/illustrator.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('names every validator kind as a `kind` bullet', () => {
    for (const kind of DRAWING_SHAPE_KINDS) {
      // Kinds are documented as backtick-quoted bullets; `stroke` alone would
      // false-positive on the paint field, so require the quoted-token form.
      expect(prompt, `prompt must document shape kind '${kind}'`).toContain(`\`${kind}\``);
    }
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
  });
});
