/**
 * XCH-CAD-1 (LLM-EXCHANGE-AUDIT Wave 3): the CAD Modeler prompt hand-carries
 * the solid-kind vocabulary validateCadDoc enforces (in sync by manual
 * discipline only). Pin it — the drawings agent DID drift this way
 * (XCH-DRAW-1) before Wave 1 caught it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CAD_SOLID_KINDS } from '../validateCadDoc.js';

describe('cad-modeler prompt ↔ validateCadDoc solid-kind parity (XCH-CAD-1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/feature.cad.agents/prompts/cad-modeler.md');
  const prompt = readFileSync(promptPath, 'utf8');

  it('names every solid kind as a backtick-quoted token', () => {
    for (const kind of CAD_SOLID_KINDS) {
      expect(prompt, `prompt must document solid kind '${kind}'`).toContain(`\`${kind}\``);
    }
  });
});
