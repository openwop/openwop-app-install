/**
 * DSGC-01 — the coverage RATCHET the design-system gallery lacked.
 *
 * The gallery (`GalleryPage.tsx`) is the ONE place every reusable `ui/` visual
 * primitive is supposed to have a captured specimen (rendered + snapshotted + run
 * through the axe matrix). Nothing asserted that the captured set == the `ui/`
 * primitive set, so ~17 of ~32 primitives were uncaptured AND a NEW `ui/` primitive
 * shipped uncaptured with green CI (`dsg-grade-probe.test.tsx`'s own docblock names
 * this absence and explicitly does NOT witness it).
 *
 * This is a SOURCE-SCAN, SHRINK-ONLY ratchet (the orgscope / teardown-reachability
 * pattern): it auto-enumerates `ui/*.tsx` (so a new primitive appears WITHOUT a test
 * edit), subtracts a small, reasoned EXCLUDED set of definitive non-specimens and the
 * set the gallery `import`s, and asserts the remainder equals a frozen
 * UNCAPTURED_BASELINE. A new uncaptured primitive is NOT in the baseline → the set
 * GROWS → RED. A primitive that gets captured must be REMOVED from the baseline (the
 * stale-ceiling arm) → RED until it is. The baseline may only SHRINK.
 *
 * SCOPE (honest bounds): this proves a primitive is IMPORTED by `GalleryPage`, the
 * proxy for "has a captured specimen" — `tsc`'s no-unused-import check makes
 * import⟹rendered a reasonable stand-in, and the snapshot + axe matrix are the
 * render-side coverage layered on top. It depends on the repo's FLAT `ui/*.tsx`
 * convention (only `icons/` is a subdir); a future primitive shipped as a directory
 * module (`ui/Foo/index.tsx`) would escape the non-recursive scan — capture it AND
 * widen the enumeration together if that convention ever changes.
 *
 * Anti-vacuity (a source-scan that matches nothing passes forever): the test proves
 * the enumeration is real (a floor on the primitive count), that the gallery import
 * scan is non-empty, that every EXCLUDED entry is a real file (no dead padding that
 * would quietly shrink the baseline), and that a known-captured primitive is NOT in
 * the baseline while a known-uncaptured one IS.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, '..', '..', '..', 'ui');
const GALLERY = join(HERE, '..', 'GalleryPage.tsx');

/** DEFINITIVE non-specimens — NOT visual primitives the gallery should capture.
 *  Each is an imperative API or pure portal infra, not a rendered specimen. Kept
 *  MINIMAL and reasoned so the exclusion cannot quietly shrink the baseline; every
 *  other `ui/*.tsx` (incl. ErrorBoundary's fallback + layout containers) is a
 *  primitive and, if uncaptured, is BASELINED below rather than excluded. */
const EXCLUDED: Record<string, string> = {
  announce: 'imperative a11y live-region API (announce()), not a rendered specimen',
  confirm: 'imperative confirm() promise API — the dialog it drives (ConfirmDialog) IS a primitive',
  toast: 'imperative toast()/dismiss() API — the toast visual is provider-rendered, not a specimen',
  ModalPortal: 'portal infrastructure with no standalone visual of its own',
};

/** The `ui/` visual primitives NOT YET captured by the gallery. SHRINK-ONLY —
 *  capturing one REQUIRES deleting it here (the stale-ceiling arm reds otherwise);
 *  a NEW primitive must NOT be added here to dodge the gate (that is the whole point
 *  — capture it in the gallery instead). Matches the DSGC-01 finding's "~17 of ~32". */
const UNCAPTURED_BASELINE: readonly string[] = [
  'A11yPrefsControl',
  'ColorField',
  'CommandPalette',
  'ConfirmDialog',
  'DeepLinkMissNotice',
  'ErrorBoundary',
  'IllustrativeBadge',
  'Markdown',
  'MarkdownEditor',
  'Menu',
  'Modal',
  'OrgSelectionState',
  'RunInputsForm',
  'TemplateGallery',
  'ThemeToggle',
  'ViewToggle',
  'layout',
];

/** All `ui/*.tsx` module basenames, excluding the icon set + tests. Auto-enumerated
 *  so a new primitive appears here with zero test edits. NON-recursive by design —
 *  keys on the flat `ui/*.tsx` convention (only `icons/` is a subdir today). */
function uiPrimitiveModules(): string[] {
  return readdirSync(UI_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.tsx') && !d.name.endsWith('.test.tsx'))
    .map((d) => d.name.replace(/\.tsx$/, ''))
    .filter((name) => !(name in EXCLUDED));
}

/** The `ui/` modules the gallery actually imports (its captured set). */
function galleryCapturedModules(): string[] {
  const src = readFileSync(GALLERY, 'utf8');
  const captured = new Set<string>();
  for (const m of src.matchAll(/from ['"]\.\.\/\.\.\/ui\/([A-Za-z0-9]+)(?:\/index)?\.js['"]/g)) {
    captured.add(m[1]!);
  }
  return [...captured];
}

describe('DSGC-01 — design-system gallery coverage ratchet', () => {
  it('every ui/ visual primitive is captured by the gallery, except the frozen shrink-only baseline', () => {
    const primitives = uiPrimitiveModules();
    const captured = new Set(galleryCapturedModules());
    const uncaptured = primitives.filter((p) => !captured.has(p)).sort();
    const baseline = [...UNCAPTURED_BASELINE].sort();

    // A NEW uncaptured primitive (not in the baseline) → this set grows → RED.
    // A now-captured primitive still listed in the baseline → stale ceiling → RED.
    expect(
      uncaptured,
      'A ui/ primitive is uncaptured and not baselined (capture it in GalleryPage), '
        + 'OR a baselined primitive is now captured (delete it from UNCAPTURED_BASELINE — shrink-only).',
    ).toEqual(baseline);
  });

  it('the enumeration is real, not a vacuous match-nothing gate (anti-vacuity)', () => {
    const primitives = uiPrimitiveModules();
    const captured = galleryCapturedModules();

    // A floor: the ui/ primitive set is large. A glob that silently found nothing
    // would pass the equality above with an empty baseline — this refuses that.
    expect(primitives.length, 'the ui/ primitive enumeration must be non-trivial').toBeGreaterThan(25);
    // The gallery import scan must actually resolve modules.
    expect(captured.length, 'the gallery must import real ui/ primitives').toBeGreaterThan(10);
    // A known-CAPTURED primitive must NOT be in the baseline (else the ratchet is slack).
    expect(UNCAPTURED_BASELINE).not.toContain('Button');
    // A known-UNCAPTURED primitive must be captured by the ratchet.
    expect(UNCAPTURED_BASELINE).toContain('Modal');
  });

  it('every EXCLUDED entry names a real ui/ file (no dead exclusion padding the baseline down)', () => {
    const all = new Set(
      readdirSync(UI_DIR)
        .filter((n) => n.endsWith('.tsx') && !n.endsWith('.test.tsx'))
        .map((n) => n.replace(/\.tsx$/, '')),
    );
    for (const name of Object.keys(EXCLUDED)) {
      expect(all.has(name), `EXCLUDED "${name}" must be a real ui/ module — a phantom exclusion silently shrinks the gate`).toBe(true);
    }
  });
});

/**
 * DSGC-02 — the SNAPSHOT loop's section list is hand-maintained.
 *
 * `e2e/design-system.spec.ts` iterates a literal `SECTIONS` array rather than
 * querying the live `[data-gallery]` sections, so adding a `<Section id="…">` to
 * `GalleryPage.tsx` renders a specimen that is never snapshotted and never fails —
 * the same silent-omission shape `DSGC-01` closed one level up (there: a primitive
 * absent from the gallery; here: a gallery section absent from the capture).
 *
 * The real fix belongs in the spec (drive the loop off the live query), but that
 * file runs only under `ci:full`'s Playwright lane, which this repo's default gate
 * does not execute — a change verified by nothing is not a fix. So the contract is
 * pinned HERE, in the lane that always runs: the two lists must agree, and adding a
 * section without extending the capture list reds.
 */
describe('DSGC-02 — every rendered gallery section is in the e2e snapshot list', () => {
  const galleryIds = (): string[] => {
    const src = readFileSync(GALLERY, 'utf8');
    return [...src.matchAll(/<Section\s+id="([^"]+)"/g)].map((m) => m[1]!).sort();
  };
  const specIds = (): string[] => {
    const spec = readFileSync(join(HERE, '..', '..', '..', '..', 'e2e', 'design-system.spec.ts'), 'utf8');
    const block = /const SECTIONS = \[([\s\S]*?)\] as const;/.exec(spec)?.[1] ?? '';
    return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
  };

  it('both lists are non-empty (a broken scan must not pass as agreement)', () => {
    expect(galleryIds().length, 'the <Section id="…"> scan found nothing').toBeGreaterThan(5);
    expect(specIds().length, 'the SECTIONS array scan found nothing').toBeGreaterThan(5);
  });

  it('the e2e capture list EQUALS the set of sections the page renders', () => {
    expect(specIds()).toEqual(galleryIds());
  });

  it('control: the detectors see a planted section / entry (so equality is a measurement)', () => {
    const planted = `<Section id="brand-new" title={t('x')}>`;
    expect([...planted.matchAll(/<Section\s+id="([^"]+)"/g)].map((m) => m[1])).toEqual(['brand-new']);
    const plantedSpec = "const SECTIONS = [\n  'only-one',\n] as const;";
    const block = /const SECTIONS = \[([\s\S]*?)\] as const;/.exec(plantedSpec)?.[1] ?? '';
    expect([...block.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['only-one']);
  });
});
