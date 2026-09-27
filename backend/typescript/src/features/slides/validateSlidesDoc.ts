/**
 * Editor-doc validation for `canvas.slides` working copies (ADR 0310 Phase B).
 * Mirrors the artifact schema's hard caps (artifactTypes.ts — 1..100 slides,
 * the 6-layout closed world, per-field length caps) PLUS the editor identity
 * fields the canvas framework's frames trait needs: per-slide `id` (slug,
 * unique) and `name`. The run artifact itself keeps the positional schema and
 * is never mutated — this validates only the `host.canvas` working copy on
 * PATCH (hard errors reject the write with 422; no soft warnings — slides have
 * no cross-references).
 */

export interface SlidesValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

import { validateComponentTree } from '../../host/canvasComponentCatalog.js';
import { SLIDES_CANVAS_TYPE } from './blockCatalog.js';

// Exported so the slides catalog surface + agent-prompt parity test can pin
// the Slide Designer's hand-carried vocabulary (XCH-SLIDES-1, Wave 3).
export const SLIDE_LAYOUTS = ['title', 'title-bullets', 'section', 'quote', 'image', 'blank', 'blocks'] as const;
const LAYOUTS = new Set<string>(SLIDE_LAYOUTS);
const VARIANTS = new Set(['full', 'hero', 'split', 'two-col']);
export const SLIDE_TRANSITIONS = ['none', 'fade', 'magic'] as const;
const TRANSITIONS = new Set<string>(SLIDE_TRANSITIONS);
export const SLIDE_THEMES = ['default', 'light', 'dark', 'editorial', 'vibrant', 'brand'] as const;
const THEMES = new Set<string>(SLIDE_THEMES);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SLIDES = 100;

/** Slide fields beyond the editor identity pair. */
const BACKGROUNDS = new Set(['default', 'accent']);
const SLIDE_FIELDS: Record<string, { max: number } | 'bullets' | 'background'> = {
  title: { max: 240 },
  subtitle: { max: 400 },
  attribution: { max: 200 },
  imageUrl: { max: 2000 },
  notes: { max: 4000 },
  bullets: 'bullets',
  // ADR 0328 Phase 2 — the closed per-slide background accent.
  background: 'background',
};

/** Fields validated separately below (ADR 0328 P3 blocks + P4 skip). */
const BLOCK_SLIDE_FIELDS = new Set(['variant', 'blocks', 'skip', 'transition', 'build']);

/** Strip the EDITOR identity fields (per-slide `id`/`name`) so a working copy
 *  can be re-emitted as a `canvas.slides` ARTIFACT — the artifact schema is
 *  positional (`additionalProperties: false`) and would reject them (grade
 *  pass DATA-CV-2: slides is the ONLY type whose editor doc diverges from its
 *  artifact schema; any future export/re-emit path MUST route through this). */
export function normalizeDeckForArtifact(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state };
  if (Array.isArray(state.slides)) {
    out.slides = state.slides.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw as unknown;
      const rest = { ...(raw as Record<string, unknown>) };
      delete rest.id;
      delete rest.name;
      return rest;
    });
  }
  return out;
}

export function validateSlidesDoc(state: Record<string, unknown>): SlidesValidation {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string): void => { errors.push({ path, message }); };

  if (state.title !== undefined && (typeof state.title !== 'string' || state.title.length > 200)) {
    err('title', 'deck title must be a string of at most 200 characters');
  }
  if (state.theme !== undefined && (typeof state.theme !== 'string' || !THEMES.has(state.theme))) {
    err('theme', `theme must be one of: ${[...THEMES].join(', ')}`);
  }

  const slides = state.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    err('slides', 'a deck needs at least one slide');
    return { errors, warnings: [] };
  }
  if (slides.length > MAX_SLIDES) err('slides', `a deck holds at most ${MAX_SLIDES} slides`);

  const ids = new Set<string>();
  slides.forEach((raw, i) => {
    const path = `slides[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      err(path, 'each slide must be an object');
      return;
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.layout !== 'string' || !LAYOUTS.has(s.layout)) {
      err(`${path}.layout`, `layout must be one of: ${[...LAYOUTS].join(', ')}`);
    }
    // Editor identity fields (the frames trait's FrameBase).
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
      err(`${path}.id`, 'slide id must be a lowercase slug (a-z, 0-9, dashes; max 64)');
    } else if (ids.has(s.id)) {
      err(`${path}.id`, `duplicate slide id '${s.id}'`);
    } else {
      ids.add(s.id);
    }
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 200) {
      err(`${path}.name`, 'slide name must be a non-empty string of at most 200 characters');
    }
    for (const [field, spec] of Object.entries(SLIDE_FIELDS)) {
      const v = s[field];
      if (v === undefined) continue;
      if (spec === 'background') {
        if (typeof v !== 'string' || !BACKGROUNDS.has(v)) {
          err(`${path}.background`, `background must be one of: ${[...BACKGROUNDS].join(', ')}`);
        }
      } else if (spec === 'bullets') {
        if (!Array.isArray(v) || v.length > 12 || v.some((b) => typeof b !== 'string' || b.length > 400)) {
          err(`${path}.bullets`, 'bullets must be at most 12 strings of at most 400 characters each');
        }
      } else if (typeof v !== 'string' || v.length > spec.max) {
        err(`${path}.${field}`, `${field} must be a string of at most ${spec.max} characters`);
      }
    }
    // ADR 0328 Phase 4 — presenter semantics.
    if (s.skip !== undefined && typeof s.skip !== 'boolean') {
      err(`${path}.skip`, 'skip must be a boolean');
    }
    // ADR 0328 Phase 5 — motion.
    if (s.transition !== undefined && (typeof s.transition !== 'string' || !TRANSITIONS.has(s.transition))) {
      err(`${path}.transition`, `transition must be one of: ${[...TRANSITIONS].join(', ')}`);
    }
    if (s.build !== undefined) {
      if (typeof s.build !== 'boolean') err(`${path}.build`, 'build must be a boolean');
      else if (s.build && s.layout !== 'blocks') err(`${path}.build`, "build is only valid on a 'blocks' slide");
    }
    // ADR 0328 Phase 3 — blocks-based slides: the closed catalog gate.
    if (s.variant !== undefined && (typeof s.variant !== 'string' || !VARIANTS.has(s.variant))) {
      err(`${path}.variant`, `variant must be one of: ${[...VARIANTS].join(', ')}`);
    }
    if (s.blocks !== undefined) {
      if (s.layout !== 'blocks') {
        err(`${path}.blocks`, "blocks are only valid on a slide with layout 'blocks'");
      } else if (!Array.isArray(s.blocks) || s.blocks.length > 40) {
        err(`${path}.blocks`, 'blocks must be an array of at most 40 entries');
      } else {
        for (const e of validateComponentTree(SLIDES_CANVAS_TYPE, s.blocks, `${path}.blocks`)) {
          err(e.path, e.message);
        }
      }
    } else if (s.layout === 'blocks') {
      err(`${path}.blocks`, "a 'blocks' slide requires a blocks array");
    }
    for (const key of Object.keys(s)) {
      if (key !== 'layout' && key !== 'id' && key !== 'name' && !(key in SLIDE_FIELDS) && !BLOCK_SLIDE_FIELDS.has(key)) {
        err(`${path}.${key}`, `unknown slide field '${key}'`);
      }
    }
  });

  for (const key of Object.keys(state)) {
    if (key !== 'title' && key !== 'theme' && key !== 'slides') {
      err(key, `unknown deck field '${key}'`);
    }
  }

  return { errors, warnings: [] };
}
