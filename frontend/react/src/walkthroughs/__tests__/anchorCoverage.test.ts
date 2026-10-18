/**
 * ADR 0489 D3/D5 — the ANCHOR COVERAGE RATCHET.
 *
 * The walkthrough engine defeats selector rot structurally: a step names a
 * SEMANTIC action id, and the registration resolves a live element through a
 * `data-walkthrough` anchor placed next to the component it targets. That only
 * works if the anchors EXIST. When the ratchet landed only 21 of 96 nav-entry
 * screens had one — which is why ADR 0378's instrumentation sweep stalled and
 * why the tutorial library (ADR 0488) could not be built on top of it.
 * (First measurement said 17 of 98; the scanner then learned to exclude
 * redirect-only routes and to follow a shell component one import deep, and
 * the first drawdown instrumented four screens. Both corrections shrank the
 * debt honestly.)
 *
 * Successive drawdowns anchored the page root on EVERY render branch
 * (loading/empty/loaded), so a screen is driveable in the state a learner
 * actually lands in, not only the happy one. Round 2 took the 16 screens using
 * the standard section root; round 3 took 29 more by first MEASURING the root
 * shapes that remained and sweeping the four unambiguous clusters (`page`,
 * `u-gap-3 u-flex u-flex-col`, `u-grid u-gap-4`, `u-flex-col u-gap-4`) rather
 * than guessing per screen. Exemptions: 79 → 75 → 59 → 30 → 27 → **3**. Round 4 took the `page-shell` cluster;
 * the rest were MEASURED as genuinely heterogeneous — several 'roots' turned out to be
 * sub-components, so a sweep really would anchor arbitrary containers.
 *
 * An audit is a snapshot; a test is a ratchet (ADR 0419 §Correction). So:
 *
 *   every screen reachable from a nav entry MUST expose `data-walkthrough`,
 *   UNLESS it is on the EXEMPT list below — and that list may only SHRINK.
 *
 * A new nav entry without an anchor fails the build. Removing an anchor from an
 * already-covered screen fails the build. Deleting a line from EXEMPT after
 * instrumenting the screen is the intended direction of travel.
 *
 * D5 (no silent caps): the exemption list is explicit, per-route, and counted in
 * the assertion below, so "how much debt is left" is always a visible number
 * rather than a quietly-skipped set.
 *
 * SCOPE NOTE (an honest narrowing of the ADR's wording): the ADR says "page root
 * AND primary action". "Primary action" is not reliably detectable by static
 * scan — naming it would mean guessing which button matters, and a guess that
 * fires the build is worse than no guard. This ratchet therefore enforces the
 * detectable half: the screen carries AT LEAST ONE anchor. That is exactly the
 * bottleneck (an uninstrumented screen cannot be driven at all). ADR 0489 OQ3
 * already scoped widening to the drawdown; see the ADR's correction note.
 *
 * w51 r2 (/grade-tests): the floors are the MEASURED truth (108 screens, 25 spotlight
 * anchors — both were far lower), an anchor is the ATTRIBUTE in code (a comment no
 * longer counts), and the spotlight check reads product sources only. Sabotage-
 * witnessed: renaming the /cli anchor (or hiding it behind a comment), dropping a nav
 * entry and renaming a core spotlight anchor each red their case.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Route modules that declare nav entries — `chrome/features.tsx` is the core
 *  SSoT; feature packages declare their own in `features/<id>/routes.tsx`. */
function routeModules(): string[] {
  return [
    'src/chrome/features.tsx',
    ...readdirSync('src/features')
      .map((d) => `src/features/${d}/routes.tsx`)
      .filter((p) => existsSync(p)),
  ];
}

/** componentName → import specifier, covering both the `lazy(() => import())`
 *  idiom the route tables use and plain named imports. */
function importMap(src: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const [, name, spec] of src.matchAll(/const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*'([^']+)'/g)) {
    if (name && spec) m.set(name, spec);
  }
  for (const [, names, spec] of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    if (!names || !spec) continue;
    for (const n of names.split(',')) {
      const t = n.trim().split(/\s+as\s+/).pop()?.trim();
      if (t) m.set(t, spec);
    }
  }
  return m;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) if (existsSync(base + ext)) return base + ext;
  return null;
}

interface NavScreen { path: string; component: string; file: string | null }

/** Every nav-entry screen, with the source file that renders it. Redirect-only
 *  routes (`<Navigate/>`, `*Redirect`) are NOT screens and are excluded. */
function navScreens(): NavScreen[] {
  const found: NavScreen[] = [];
  for (const f of routeModules()) {
    const src = readFileSync(f, 'utf8');
    const imap = importMap(src);
    // `(?!path:)` — the path→nav window must never cross into the NEXT route
    // object: without it, a nav-less route directly above a nav route could
    // pair ITS path with the neighbour's nav whenever the two sit within the
    // 600-char window (surfaced when ADR 0510 P3's `archetype:` field shifted
    // distances and three unrelated routes started failing).
    for (const mm of src.matchAll(/\{[^{}]*?path:\s*'([^']+)'(?:(?!path:)[\s\S]){0,600}?nav:\s*\{/g)) {
      const path = mm[1];
      if (!path) continue;
      const seg = src.slice(mm.index, mm.index + 800);
      const component = seg.match(/element:\s*<(\w+)/)?.[1];
      if (!component) continue;
      if (component === 'Navigate' || /Redirect$/.test(component)) continue;
      found.push({ path, component, file: resolveSpec(f, imap.get(component) ?? '') });
    }
  }
  return found;
}

/**
 * Does this screen carry an anchor ANYWHERE in the part of its render tree we
 * can see statically?
 *
 * The route component is frequently a thin shell that delegates to the real
 * screen (`/chat` → `ChatTab` → `TabChatDeck`, where the `chat.send` anchor
 * actually lives). Checking only the route's own file reports such screens as
 * uninstrumented when they are fully driveable — inflating the debt and, worse,
 * training people to ignore the list. So we follow RELATIVE imports one level
 * down, which covers the shell-delegates-to-screen shape without turning the
 * ratchet into a whole-program dependency walk.
 *
 * One level is a deliberate floor, not an oversight: deeper nesting means the
 * anchor is far from the route and the screen genuinely deserves its own
 * page-root anchor.
 */
/** An ANCHOR is the attribute (`data-walkthrough="…"` / `data-walkthrough={…}`) in
 *  code — not the bare word. A comment, prose, or `data-walkthrough-recorder` never
 *  counts (w51 r2: a block comment naming data-walkthrough beside a renamed attribute
 *  kept the screen "covered" — probe an-cli-comment). Measured: the strict form leaves
 *  exactly the same three offenders as the old substring test, so nothing moved. */
function carriesAnchor(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return /data-walkthrough=["{]/.test(code);
}

function hasAnchor(screen: NavScreen): boolean {
  if (!screen.file) return false;
  const src = readFileSync(screen.file, 'utf8');
  if (carriesAnchor(src)) return true;
  for (const mm of src.matchAll(/from\s*'(\.[^']+)'|import\(\s*'(\.[^']+)'/g)) {
    const child = resolveSpec(screen.file, mm[1] ?? mm[2] ?? '');
    if (child && carriesAnchor(readFileSync(child, 'utf8'))) return true;
  }
  return false;
}

/**
 * NO-GROWTH exemption list — screens that carry no `data-walkthrough` anchor yet.
 * Every line is instrumentation debt inherited from before ADR 0489, NOT a
 * decision that the screen should stay undriveable.
 *
 * ▸ To instrument a screen: add `data-walkthrough="<feature>.page"` to its page
 *   root (and register the action next to the component), then DELETE its line
 *   here. The count assertion below drops on its own.
 * ▸ You may never ADD a line. A new nav entry ships with its anchor.
 */
const EXEMPT: readonly string[] = [
  // ── The three that remain, each a DECIDED exemption rather than untriaged debt.
  //
  // All three return a FRAGMENT whose first child is a conditional `<PageHeader>`,
  // so there is no stable element to anchor. Anchoring would mean introducing a
  // wrapper `<div>`; `/widgets` and `/scheduled-chats` also render EMBEDDED inside
  // other surfaces (they take an `embedded` prop), so a wrapper risks their layout
  // somewhere other than the page being instrumented. A walkthrough anchor is not
  // worth a DOM change with that blast radius.
  //
  // To close one: give the page a real root element for its own layout reasons,
  // then anchor it and delete the line. Do NOT add a wrapper solely for the anchor.
  '/widgets',
  '/scheduled-chats',
  '/usage',
] as const;

/** The high-water mark. This number may only go DOWN. */
const EXEMPT_CEILING = 3;

describe('ADR 0489 D3 — walkthrough anchor coverage ratchet', () => {
  it('enumerates the nav-entry screens (non-vacuous — a broken scanner fails here first)', () => {
    const screens = navScreens();
    // If the route-table shape ever changes so the scanner stops matching, this
    // guard fires instead of the ratchet silently passing on an empty set.
    // FLOOR = MEASURED TRUTH (108 nav-entry screens on e3c2492be, 2026-10-16). It was
    // `> 60`, so a scanner that silently dropped 47 screens passed (w51 probe
    // an-nav-drop). Lower it ONLY when a nav entry is genuinely deleted.
    expect(screens.length).toBeGreaterThanOrEqual(108);
    expect(new Set(screens.map((s) => s.path)).size, 'one screen per nav path').toBe(screens.length);
    expect(screens.filter((s) => s.file === null)).toEqual([]);
  });

  it('every nav-entry screen carries a data-walkthrough anchor, or is explicitly exempt', () => {
    const offenders = navScreens()
      .filter((s) => !hasAnchor(s))
      .map((s) => s.path)
      .filter((p) => !EXEMPT.includes(p));
    expect(
      offenders,
      `These screens have a nav entry but no \`data-walkthrough\` anchor, and are not on the `
      + `EXEMPT list in this file. Add an anchor to the page root (see ADR 0489 D3/D4) — `
      + `do NOT add them to EXEMPT, which is shrink-only.`,
    ).toEqual([]);
  });

  it('the exemption list only shrinks (NO-GROWTH) and stays honest', () => {
    // Shrink-only: the ceiling is the recorded high-water mark.
    expect(EXEMPT.length).toBeLessThanOrEqual(EXEMPT_CEILING);
    // Honest: an entry that no longer needs exempting is stale — instrument it
    // and delete the line, don't leave a dead exemption implying debt that is gone.
    const screens = navScreens();
    const stale = EXEMPT.filter((p) => {
      const s = screens.find((x) => x.path === p);
      return !s || hasAnchor(s);
    });
    expect(
      stale,
      'These EXEMPT entries are stale — the screen is gone or now has an anchor. Delete these lines.',
    ).toEqual([]);
    // No duplicates hiding real debt behind one line.
    expect(new Set(EXEMPT).size).toBe(EXEMPT.length);
  });

  /**
   * ADR 0488 P4 — an ACTION and its ANCHOR must not drift apart.
   *
   * `registerPageSpotlight(actionId, route, anchor)` registers the action id
   * whether or not the anchor exists, so a typo'd or renamed anchor registers
   * cleanly and only fails at RUNTIME, where the player lands in `needs-update`
   * mid-walkthrough. That is exactly the rot the semantic registry exists to
   * prevent, and the registration-coverage test does NOT catch it — verified by
   * sabotage: pointing the commerce spotlight at a nonexistent anchor left that
   * suite green.
   *
   * So: every anchor named by a spotlight registration must exist as a
   * `data-walkthrough="..."` literal in the source.
   */
  it('every page-spotlight ACTION names an anchor that actually exists in the source', () => {
    // PRODUCT sources only: an anchor or registration that exists only in a test
    // fixture must never satisfy this (measured: none does today).
    const src: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); }
        else if (/\.(tsx?|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) src.push(readFileSync(full, 'utf8'));
      }
    };
    walk('src');
    const all = src.join('\n');

    // Both registration shapes: the direct call, and the CORE_PAGE_SPOTLIGHTS triples.
    const anchors = new Set<string>();
    for (const [, a] of all.matchAll(/registerPageSpotlight\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'([^']+)'/g)) if (a) anchors.add(a);
    for (const [, a] of all.matchAll(/\[\s*'[\w.-]+\.page\.view'\s*,\s*'[^']+'\s*,\s*'([^']+)'\s*\]/g)) if (a) anchors.add(a);

    // FLOOR = MEASURED TRUTH (25 spotlight anchors on e3c2492be, 2026-10-16; was `> 5`).
    expect(anchors.size, 'non-vacuous — spotlight registrations went missing from the scan').toBeGreaterThanOrEqual(25);
    const missing = [...anchors].filter((a) => !all.includes(`data-walkthrough="${a}"`));
    expect(
      missing,
      'These spotlight actions name an anchor that appears nowhere in the source. The action registers '
      + 'fine and then fails at RUNTIME (the player goes needs-update). Fix the anchor name, or add the anchor.',
    ).toEqual([]);
  });
});
