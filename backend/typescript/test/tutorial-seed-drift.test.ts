/**
 * ADR 0488 P1 — the seed↔frontend DRIFT RATCHET.
 *
 * The backend seed (`features/tutorials/seedTutorials.ts`) was GENERATED from the
 * frontend's authored modules (`frontend/react/src/features/tutorials/content/`),
 * so the two agree at birth. This pins that they keep agreeing until P4/P5
 * retires the frontend copy — a temporary duplication is only safe with a
 * ratchet on it ("an audit is a snapshot, a test is a ratchet", ADR 0419).
 *
 * It reads the frontend sources from disk rather than importing them (separate
 * packages, separate tsconfigs) and compares the two things that actually break
 * a binding if they diverge: WHICH tutorials exist, and WHICH step ids they
 * contain — step ids are the progress keys AND the ADR 0488 D1 `run` binding
 * anchors, so a silent rename would strand progress and unbind "Show me".
 *
 * Also enforces ADR 0488 D5 (<=5 steps per phase), which is a shape rule the
 * seed must satisfy before phase sub-chains can be generated from it in P3.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_TUTORIALS } from '../src/features/tutorials/seedTutorials.js';

const FE_CONTENT = join(import.meta.dirname, '../../../frontend/react/src/features/tutorials/content');

/** Tutorial id + its step ids, parsed from one authored frontend module. */
function parseFrontendTutorial(src: string): { id: string | null; stepIds: string[] } {
  // The top-level `id: 'slug',` of the exported TutorialData — the FIRST id in
  // the module, before any phase/step object.
  const id = src.match(/^\s{2}id:\s*'([^']+)'/m)?.[1] ?? null;
  // Step ids are dotted ("3.1") — distinguishable from the tutorial slug.
  const stepIds = [...src.matchAll(/\bid:\s*'(\d+(?:\.\d+)+)'/g)].map((m) => m[1]!);
  return { id, stepIds };
}

function frontendTutorials(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(FE_CONTENT)) {
    if (!f.endsWith('.ts')) continue;
    const { id, stepIds } = parseFrontendTutorial(readFileSync(join(FE_CONTENT, f), 'utf8'));
    if (id) out.set(id, stepIds);
  }
  return out;
}

describe('ADR 0488 — backend seed ↔ frontend content drift', () => {
  it('the frontend content directory is readable (non-vacuous — a moved path fails here first)', () => {
    expect(existsSync(FE_CONTENT), `frontend tutorial content not found at ${FE_CONTENT}`).toBe(true);
    expect(frontendTutorials().size).toBeGreaterThan(0);
  });

  it('the seed ships EXACTLY the tutorials the frontend authored', () => {
    expect([...SEED_TUTORIALS.map((t) => t.id)].sort()).toEqual([...frontendTutorials().keys()].sort());
  });

  it('every tutorial has the SAME step ids on both sides (progress keys + run-binding anchors)', () => {
    const fe = frontendTutorials();
    for (const t of SEED_TUTORIALS) {
      const seedSteps = t.phases.flatMap((p) => p.steps.map((s) => s.id)).sort();
      expect(seedSteps, `step ids drifted for "${t.id}"`).toEqual([...(fe.get(t.id) ?? [])].sort());
    }
  });

  it('ADR 0488 D5 — no phase exceeds 5 steps (the shape P3 generates sub-chains from)', () => {
    for (const t of SEED_TUTORIALS) {
      for (const p of t.phases) {
        expect(p.steps.length, `${t.id} phase ${p.number} has ${p.steps.length} steps`).toBeLessThanOrEqual(5);
      }
    }
  });

  it('step ids are unique within a tutorial (they key progress — a dupe silently merges two steps)', () => {
    for (const t of SEED_TUTORIALS) {
      const ids = t.phases.flatMap((p) => p.steps.map((s) => s.id));
      expect(new Set(ids).size, `duplicate step id in "${t.id}"`).toBe(ids.length);
    }
  });

  it('every seed carries a seedVersion (the refresh lifecycle depends on it)', () => {
    for (const t of SEED_TUTORIALS) expect(t.seedVersion, t.id).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * PROG-4 §Correction — the duplication was only PARTLY ratcheted.
   *
   * The assertions above pin ids, step ids and phase shape, so STRUCTURE cannot
   * drift. They say nothing about the PROSE, and prose is what a learner reads.
   * That became load-bearing once the page went server-first with the in-tree
   * floor: online a learner reads the BACKEND text, offline the FRONTEND text,
   * and nothing guaranteed those were the same words.
   *
   * Direction matters here. A first attempt scanned the FRONTEND's TS string
   * literals and produced 33 false positives, because prose containing an
   * apostrophe ("the app's surfaces") terminates a single-quoted literal and the
   * match spills into surrounding code. The backend seed is JSON — already
   * parsed, already unescaped — so it is the reliable side to read FROM. The
   * frontend is then de-escaped before comparison.
   */
  it('the authored PROSE matches on both sides, not just the structure', () => {
    // Every authored sentence the SEED carries.
    const sentences = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string') { if (v.length >= 40 && v.includes(' ')) sentences.add(v); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          // `code` blocks are verbatim snippets the frontend writes as a template
          // literal and the seed stores as an escaped string — the BYTES differ by
          // format even when the snippet is identical, so comparing them here
          // reports formatting as drift. Their presence and position are already
          // covered by the structural assertions above; this check is about PROSE.
          if (k === 'code') continue;
          walk(val);
        }
      }
    };
    walk(SEED_TUTORIALS);
    expect(sentences.size, 'non-vacuous — no authored prose found in the seed').toBeGreaterThan(20);

    // The frontend source, de-escaped so `\'` compares as `'`.
    const fe = readdirSync(FE_CONTENT)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(FE_CONTENT, f), 'utf8'))
      .join('\n')
      .replace(/\\'/g, "'");

    const drifted = [...sentences].filter((t) => !fe.includes(t));
    expect(
      drifted,
      'These sentences are in the backend seed but NOT in the frontend content, so an online reader and '
      + 'an offline reader would see different words. Regenerate the seed from the frontend content.',
    ).toEqual([]);
  });
});
