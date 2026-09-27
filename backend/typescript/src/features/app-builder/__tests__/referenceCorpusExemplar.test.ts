/**
 * Reference-corpus EXEMPLAR tripwire (grade pass 2026-07-12, ADR 0347 5b guard).
 *
 * The App Architect prompt tells the model: "Group input fields inside the
 * catalog's `form` container, not a generic layout container." That is prose —
 * and it regressed: a grade pass had to hand-fix the seed Login, the Contact
 * template, and the kit auth screens after they shipped input clusters in bare
 * stacks. This test makes the rule mechanical so the reference corpus (the seed,
 * the screen templates, the shipped kits) can never drift from the guidance it
 * is supposed to demonstrate — the same "encode the rule as a tripwire" move as
 * `catalogParity.test.ts` (prompt↔catalog) and `templatesAndChain.test.ts`.
 *
 * INVARIANT (a mechanical proxy for the prose rule): no LAYOUT container
 * (`stack`/`grid`) may DIRECTLY hold an input cluster — ≥2 input controls, or
 * ≥1 input control alongside a submit `button`. Such a cluster belongs in a
 * `form`. Deliberately scoped (architect review):
 *   - Containers = `{stack, grid}` only. `accordion`/`card`/`tabs` grouping is a
 *     legitimate different pattern, not flagged (avoids false positives).
 *   - `form` is never a flagged container (it is the goal), so a `form` holding
 *     the inputs passes — its subtree is still walked for nested drift.
 *   - `search` is NOT an input control here: a lone search box + a Go button in a
 *     filter/toolbar is legitimate, not a form. The vocabulary is derived from
 *     the catalog SSoT (`category === 'input'`) minus `form` and `search`.
 *   - The nav rule ("bare stack of navigateTo links → navBar") is intentionally
 *     NOT enforced — it would fire on the kit's legitimate footer links.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { auroraDoc } from '../../../host/demoAppBuilderSeed.js';
import { SCREEN_TEMPLATES } from '../screenTemplates.js';
import { APP_BUILDER_COMPONENTS } from '../componentCatalog.js';
import {
  loadCanvasContentPacks,
  kitsForCanvasType,
  _resetCanvasContentRegistryForTest,
} from '../../../host/canvasContentPackLoader.js';
import { locateRepoDir } from '../../../host/_repoPath.js';

const APP_BUILDER_CANVAS_TYPE = 'canvas.app-builder';

/** Form-FIELD vocabulary, derived from the catalog SSoT (not hand-copied). The
 *  `input` category also holds INPUT CONTAINERS (`form` — excluded by
 *  `acceptsChildren`, so any future input-container is auto-excluded too) and
 *  leaf ACTIONS/affordances (`button`/`fab`/`search` — not fields; `button` is
 *  checked separately as the submit signal). Only genuine leaf actions are
 *  hand-listed, so the exclusion can't silently miscount a future field. */
const NON_FIELD_ACTIONS = new Set(['button', 'fab', 'search']);
const INPUT_CONTROLS = new Set(
  APP_BUILDER_COMPONENTS
    .filter((c) => c.category === 'input' && !c.acceptsChildren && !NON_FIELD_ACTIONS.has(c.type))
    .map((c) => c.type),
);
const LAYOUT_CONTAINERS = new Set(['stack', 'grid']);

interface Node { type?: unknown; children?: unknown }
const asNode = (v: unknown): Node => (v && typeof v === 'object' ? (v as Node) : {});
const childrenOf = (n: Node): Node[] => (Array.isArray(n.children) ? n.children.map(asNode) : []);
const typeOf = (n: Node): string => (typeof n.type === 'string' ? n.type : '');

/** Every layout container that directly holds an input cluster, as readable paths. */
function findExemplarDrift(roots: unknown[], surface: string): string[] {
  const out: string[] = [];
  const visit = (n: Node, path: string): void => {
    const t = typeOf(n);
    const kids = childrenOf(n);
    if (LAYOUT_CONTAINERS.has(t)) {
      const inputs = kids.filter((c) => INPUT_CONTROLS.has(typeOf(c)));
      const hasSubmit = kids.some((c) => typeOf(c) === 'button');
      if (inputs.length >= 2 || (inputs.length >= 1 && hasSubmit)) {
        out.push(`${surface} → ${path}${t}: [${inputs.map(typeOf).join(', ')}]${hasSubmit && inputs.length < 2 ? ' + submit button' : ''} — wrap in a form`);
      }
    }
    kids.forEach((c, i) => visit(c, `${path}${t}[${i}]/`));
  };
  (Array.isArray(roots) ? roots : []).map(asNode).forEach((n, i) => visit(n, `[${i}]/`));
  return out;
}

describe('reference-corpus exemplar tripwire (ADR 0347 5b — the corpus must demonstrate the prompt rule)', () => {
  beforeAll(() => {
    // Walk ONLY the repo `packs/` dir — never the runtime multi-root loader,
    // which would admit an external kit via OPENWOP_PACK_DIR /
    // OPENWOP_CANVAS_CONTENT_PACKS_DIR and diverge local-vs-CI (grade pass
    // RC-1). Deterministic + repo-scoped, matching the catalogParity /
    // templatesAndChain sibling tripwires; still auto-covers a future repo kit.
    _resetCanvasContentRegistryForTest();
    const repoPacksDir = locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'core.openwop.artifact-types/pack.json');
    loadCanvasContentPacks({ roots: [repoPacksDir] });
  });

  it('the demo seed (Aurora) groups inputs in a form, never a bare stack', () => {
    const screens = (auroraDoc().screens as unknown[]) ?? [];
    const drift = screens.flatMap((s, i) =>
      findExemplarDrift((asNode(s) as { components?: unknown }).components as unknown[] ?? [], `seed:screen[${i}]`),
    );
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('every screen template groups inputs in a form', () => {
    const drift = SCREEN_TEMPLATES.flatMap((t) => findExemplarDrift(t.components as unknown[], `template:${t.id}`));
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('every shipped kit screen groups inputs in a form', () => {
    const kits = kitsForCanvasType(APP_BUILDER_CANVAS_TYPE);
    expect(kits.length, 'at least the auth-flow kit must load').toBeGreaterThan(0);
    const drift = kits.flatMap((k) =>
      k.screens.flatMap((s, i) => findExemplarDrift((asNode(s) as { components?: unknown }).components as unknown[] ?? [], `kit:${k.kitId}#screen[${i}]`)),
    );
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('the predicate FIRES on a bare stack of inputs (no false-negative from a walk bug)', () => {
    const bad = [{ type: 'stack', children: [
      { type: 'textInput', props: {} },
      { type: 'textInput', props: {} },
      { type: 'button', props: { label: 'Submit' } },
    ] }];
    expect(findExemplarDrift(bad, 'synthetic')).toHaveLength(1);
    // …and a single input in a stack (a search filter) is permitted.
    const ok = [{ type: 'stack', children: [{ type: 'textInput', props: {} }, { type: 'list', children: [] }] }];
    expect(findExemplarDrift(ok, 'synthetic')).toEqual([]);
    // …and the same inputs inside a form are permitted.
    const wrapped = [{ type: 'stack', children: [{ type: 'form', children: [
      { type: 'textInput', props: {} }, { type: 'textInput', props: {} }, { type: 'button', props: {} },
    ] }] }];
    expect(findExemplarDrift(wrapped, 'synthetic')).toEqual([]);
  });
});
