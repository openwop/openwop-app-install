/**
 * XCH-SLIDES-1 (LLM-EXCHANGE-AUDIT Wave 3) — the app-builder ADR 0358 pattern
 * ported to slides. Pins, in both directions:
 *  1. the surface catalog projection == the SSoT (blockCatalog/validateSlidesDoc);
 *  2. the pack's pinned fallback == the generated list (covered by
 *     slidesDesignChain.test.ts; re-asserted here via the projection);
 *  3. the Slide Designer prompt teaches the catalog TOOL and no longer
 *     hand-carries the block-type list (inverted tripwire, sentinel types);
 *  4. the prompt's remaining hand-carried vocabularies (layouts / variants /
 *     themes / transitions) match the validator's closed world;
 *  5. the pack draft prompt's hand-written props menu names every SSoT block
 *     type and its props/enum options (prop-level drift pin).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { SLIDE_BLOCKS, SLIDE_VARIANTS, registerSlideBlocks } from '../blockCatalog.js';
import { SLIDE_LAYOUTS, SLIDE_THEMES, SLIDE_TRANSITIONS } from '../validateSlidesDoc.js';
import { slidesCatalogProjection } from '../surface.js';

registerSlideBlocks();

const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, '../../../../../../packs/feature.slides.agents/prompts/slide-designer.md');
const packPath = join(here, '../../../../../../packs/feature.slides.nodes/index.mjs');
const prompt = readFileSync(promptPath, 'utf8');
const packSource = readFileSync(packPath, 'utf8');

describe('surface catalog projection ↔ SSoT (XCH-SLIDES-1)', () => {
  const cat = slidesCatalogProjection();
  it('blockTypeList is generated from SLIDE_BLOCKS', () => {
    expect(cat.blockTypeList.split(', ').sort()).toEqual(SLIDE_BLOCKS.map((b) => b.type).sort());
  });
  it('promptSchema covers every block type', () => {
    for (const b of SLIDE_BLOCKS) expect(cat.promptSchema).toContain(`- ${b.type}`);
  });
  it('carries the validator vocabularies', () => {
    expect(cat.layouts).toEqual(SLIDE_LAYOUTS);
    expect(cat.variants).toEqual(SLIDE_VARIANTS);
    expect(cat.themes).toEqual(SLIDE_THEMES);
    expect(cat.transitions).toEqual(SLIDE_TRANSITIONS);
  });
});

describe('slide-designer prompt ↔ catalog INDEPENDENCE (inverted tripwire)', () => {
  it('teaches the catalog tool', () => {
    expect(prompt).toContain('openwop:slides.catalog');
  });
  it('no longer hand-carries the block-type list (sentinels absent)', () => {
    for (const sentinel of ['callout', 'spacer']) {
      expect(prompt, `prompt must not hand-carry block type '${sentinel}'`).not.toContain(sentinel);
    }
  });
  it('still pins the validator vocabularies it legitimately carries', () => {
    for (const l of SLIDE_LAYOUTS) expect(prompt, `layout '${l}'`).toContain(`\`${l}\``);
    for (const v of SLIDE_VARIANTS) expect(prompt, `variant '${v}'`).toContain(`\`${v}\``);
    for (const t of SLIDE_THEMES) expect(prompt, `theme '${t}'`).toContain(`\`${t}\``);
    for (const t of SLIDE_TRANSITIONS) expect(prompt, `transition '${t}'`).toContain(`\`${t}\``);
  });
});

describe('pack draft prompt props menu ↔ SLIDE_BLOCKS (prop-level pin)', () => {
  const menu = packSource.slice(packSource.indexOf('Props by type:'));
  it('found the hand-written props menu', () => {
    expect(menu.length).toBeGreaterThan(100);
  });
  it('names every block type with every prop and enum option', () => {
    for (const b of SLIDE_BLOCKS) {
      const seg = menu.match(new RegExp(`${b.type}\\{([^}]*)`));
      expect(seg, `props menu must carry '${b.type}{'`).toBeTruthy();
      for (const p of b.props ?? []) {
        expect(seg![1], `menu for '${b.type}' must name prop '${p.name}'`).toContain(p.name);
        if (p.type === 'enum') {
          for (const opt of p.options ?? []) {
            expect(seg![1], `menu for '${b.type}.${p.name}' must carry enum '${opt}'`).toContain(opt);
          }
        }
      }
    }
  });
});
