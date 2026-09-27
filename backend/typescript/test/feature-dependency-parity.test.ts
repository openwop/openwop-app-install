/**
 * ADR 0439 — feature-dependency graph integrity.
 *
 * ADR 0194's `dependsOn` graph is enforced as a DISABLE-LOCK (a feature cannot be
 * turned off while an enabled feature hard-depends on it). Features also couple by
 * DIRECT IMPORT, and those edges are invisible to the graph. A full static scan
 * found 184 cross-feature import edges with only 19 declared.
 *
 * The naive conclusion — "declare the other 165" — is WRONG, and this file encodes
 * why, so nobody re-derives it:
 *
 *  - 70 edges point at ALWAYS-ON substrate. `features/types.ts` is explicit: "A dep
 *    that is always-on substrate (no `toggleDefault`) is always satisfied and never
 *    blocks." Declaring those adds a lock that can never fire.
 *  - `dependsOn` is not documentation. Every edge ALSO closes the white-label
 *    composer's selection (`BundleShopPage.tsx` → `composed.autoRequired`) and must
 *    keep `core` dependsOn-closed (`gen-distribution.mjs` — a core→non-core edge is
 *    a BUILD ERROR). Under ADR 0419 the same catalog drives what a tenant BUYS, so
 *    a stray edge silently widens a paid bundle.
 *  - An import edge is not a hard dep. Toggles are RUNTIME. A caller only breaks if
 *    the target REFUSES when off — and the audited targets (`documents`, `entities`,
 *    `territories`) do not gate their service layer at all; only their routes 404.
 *    So the callers keep working, and a lock would be fiction.
 *
 * Hence: no new edges were declared. What IS enforced here are the invariants that
 * caught real bugs, plus a ratchet so the gap cannot silently widen.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';

const FEATURES_DIR = join(import.meta.dirname, '../src/features');

const featureIds = new Set(BACKEND_FEATURES.map((f) => f.id));
const declared = new Map<string, string[]>(BACKEND_FEATURES.map((f) => [f.id, [...(f.dependsOn ?? [])]]));
const isAlwaysOn = (id: string): boolean => !BACKEND_FEATURES.find((f) => f.id === id)?.toggleDefault;

/** Every non-test .ts under a feature dir. */
function sources(featureId: string): string[] {
  const root = join(FEATURES_DIR, featureId);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); continue; }
      if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Real cross-feature import edges A→B. Covers BOTH static `from '../b/x.js'` and
 * dynamic `await import('../b/x.js')` — 10 edges exist ONLY dynamically, so a
 * static-only scan under-reports and would give a false all-clear.
 */
function importEdges(): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const a of featureIds) {
    const targets = new Set<string>();
    for (const file of sources(a)) {
      const src = readFileSync(file, 'utf8');
      // RESOLVE the specifier against the importing file rather than matching a
      // fixed `../` depth. The previous regex only saw `from '../<feature>/'`,
      // i.e. files sitting DIRECTLY in a feature dir — so every import from a
      // subdirectory (`features/a/domain/x.ts` → `'../../crm/…'`) was invisible.
      // 19 features have subdirectories, and real edges (commerce/ucp→users,
      // commerce/ucp→billing, territories/entities→crm) were being under-reported,
      // which is a false all-clear on exactly the coupling this test polices.
      for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g)) {
        const resolved = resolve(dirname(file), m[1]!);
        const rel = relative(FEATURES_DIR, resolved);
        if (rel.startsWith('..')) continue; // outside features/ — host, storage, …
        const b = rel.split(sep)[0];
        // Only sibling FEATURE dirs; shared seams live directly in features/
        // (types.js, featureRoute.js, index.js, …) and are not feature coupling.
        if (b && b !== a && featureIds.has(b)) targets.add(b);
      }
    }
    edges.set(a, targets);
  }
  return edges;
}

describe('ADR 0439 — feature dependency graph integrity', () => {
  const edges = importEdges();

  it('every DECLARED dependency is backed by a real import (no phantom locks)', () => {
    // This is the check that caught `kicktodo-community` declaring `kicktodo-creator`
    // with no import of it (the only textual match was a KV namespace string), while
    // NOT declaring `kicktodo-commerce`, which it does import. A declared-but-unused
    // dep locks a feature the package does not need.
    const stale: string[] = [];
    for (const [a, deps] of declared) {
      for (const b of deps) {
        if (!edges.get(a)?.has(b)) stale.push(`${a} declares dependsOn '${b}' but never imports it`);
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('an always-on DECLARED dependency is allowed, and recorded as a deliberate choice', () => {
    // A first draft FAILED on any declared dep targeting always-on substrate, on the
    // grounds that such a lock can never fire (types.ts: "always satisfied and never
    // blocks"). That rule was WRONG for this codebase, and the disagreement is worth
    // keeping visible rather than silently resolving:
    //
    //   `kicktodo-core` declares `goals` — always-on, core tier — with an explicit
    //   rationale ("the dependency is real: the enrollment saga creates one ADR 0412
    //   goal per enrollment. Declaring it is free... and records the relationship").
    //
    // That reasoning holds: `goals` is core, so it is in every distribution and the
    // composer closure cost is exactly zero, while the declaration documents a real
    // runtime relationship. So this is a STYLE choice the project has already made,
    // not a defect — and a test has no business overruling a documented decision by
    // another author. What IS enforced is the check above: a declared dep must be
    // backed by a real import. That is what caught the genuine bug
    // (`kicktodo-community → kicktodo-creator`, declared with no import at all).
    const alwaysOnDeps = [...declared].flatMap(([a, deps]) =>
      deps.filter((b) => featureIds.has(b) && isAlwaysOn(b)).map((b) => `${a} → ${b}`),
    );
    // Informational: these are allowed. The assertion is only that they stay
    // import-backed, which the first case already guarantees.
    expect(Array.isArray(alwaysOnDeps)).toBe(true);
  });

  it('the DECLARED graph is acyclic', () => {
    // A cycle would not hang (computeDisableBlockers is one-hop) — it would silently
    // make every feature in it permanently mutually undisableable. The real IMPORT
    // graph already has 16 cycles, so this is a live hazard, not a theoretical one.
    const colour = new Map<string, number>(); // 0=open 1=closed
    const found: string[] = [];
    const visit = (id: string, path: string[]): void => {
      if (colour.get(id) === 1) return;
      if (colour.get(id) === 0) { found.push([...path.slice(path.indexOf(id)), id].join(' → ')); return; }
      colour.set(id, 0);
      for (const dep of declared.get(id) ?? []) visit(dep, [...path, dep]);
      colour.set(id, 1);
    };
    for (const id of declared.keys()) visit(id, [id]);
    expect(found, `declared dependency cycle(s):\n${found.join('\n')}`).toEqual([]);
  });

  it('every DECLARED dependency resolves to a registered feature', () => {
    const dangling: string[] = [];
    for (const [a, deps] of declared) {
      for (const b of deps) if (!featureIds.has(b)) dangling.push(`${a} → ${b} (not a registered feature)`);
    }
    expect(dangling, dangling.join('\n')).toEqual([]);
  });

  it('the undeclared-edge gap does not silently widen (ratchet)', () => {
    // The undeclared edges are DEBT, not a target: most are onto always-on substrate
    // (correctly undeclared), and the rest sit in a cycle cluster where a declaration
    // would deadlock the CRM/commerce group. Rather than an allowlist of 165 lines
    // nobody reads, ratchet the COUNT: new coupling is allowed, but it must be
    // NOTICED. The bound is the exact current value — slack would let drift
    // accumulate silently, which is the failure this whole ADR is about. If a
    // legitimate new import trips this, raise the number IN THE SAME COMMIT and say
    // why; if you remove coupling, lower it so the ratchet keeps holding.
    const undeclaredOntoToggleable = [...edges].flatMap(([a, targets]) =>
      [...targets].filter((b) => !isAlwaysOn(b) && !(declared.get(a) ?? []).includes(b)).map((b) => `${a}→${b}`),
    );
    // 84 → 85 (ADR 0488 P1, 2026-07-25): `tutorials → entities`. The tutorials
    // narrative moved into the entities content KERNEL (ADR 0408 made it the
    // app's single content store), so the read edge is the point of the change,
    // not an accident. Deliberately left UNDECLARED for the reason this file
    // already documents: `dependsOn` is a disable-LOCK, and entities does not
    // gate its service layer — a lock would be fiction. The off case is handled
    // by ADR 0488 D3's seed floor (`tutorialsService.ts`), which degrades the
    // reader to the shipped copy instead of breaking it, and is tested by
    // `tutorials-service.test.ts` § "the degraded-mode floor".
    // 85 → 90 (ADR 0541, 2026-08-11): the count rose because DETECTION improved,
    // NOT because coupling grew. `importEdges` matched a fixed `from '../<feature>/'`
    // depth, so it only saw files sitting directly in a feature dir — every import
    // from a SUBDIRECTORY was invisible, and 19 features have subdirectories. The
    // scan now resolves each specifier against the importing file. The five newly
    // visible edges (commerce→billing, commerce→analytics, commerce→email,
    // commerce→entities, from `commerce/ucp/*`) are pre-existing and were being
    // under-reported — a false all-clear on exactly the coupling this test polices.
    // No edge was added by this change; `job-search→crm` is DECLARED and so does
    // not count here.
    expect(
      undeclaredOntoToggleable.length,
      `undeclared→toggleable edges:\n${undeclaredOntoToggleable.sort().join('\n')}`,
    // 90 → 91 (ADR 0542 P1, 2026-08-11): `job-search → entities`. The job
    // listing is a system-type façade on the entities KERNEL (ADR 0409/0410
    // precedent), so the edge is the point of the design, not an accident.
    // Deliberately left UNDECLARED: `dependsOn` is a disable-LOCK, and the
    // entities SERVICE layer has no toggle gate — the architect review confirmed
    // this by reading `putSystemEntity`, which never consults it. A lock would
    // be fiction, exactly the tutorials→entities precedent recorded above.
    // 91 → 92 (UX_UPGRADE-projects R2 PRJ2-B2, 2026-08-11): `projects →
    // notebooks`. A notebook IS a project (`facet:'notebook'`) whose bound KB
    // collection is EXCLUSIVE to it, and only `deleteNotebook` deletes that
    // collection — so `DELETE /projects/:id` was stranding the whole ingested
    // corpus under a confirm reading "cannot be undone". The delegation is the
    // point of the fix. It sits at the ROUTE because `notebooksService` already
    // imports `projectsService`; calling the other way in the service layer
    // would be a cycle. Deliberately left UNDECLARED for the reason above:
    // `dependsOn` is a disable-LOCK, and with notebooks OFF no notebook-facet
    // project can be created, so the branch is vacuous rather than broken —
    // while a lock would wrongly make notebooks undisableable.
    // 92 → 95 (CMNT-2, 2026-08-19): `cms → comments`, `kb → comments`,
    // `priority-matrix → comments`. Deleting a cms page, a kb collection or a
    // priority idea left its comment threads behind — parentless rows that
    // outlived the thing they discussed, on 3 of the 6 commentable resource
    // types. Each deleter now prunes its own threads, so the edge is the point
    // of the fix, exactly as in the projects→notebooks entry above.
    // All three are DYNAMIC imports, and that is load-bearing rather than
    // stylistic: `commentsService` statically imports `priorityMatrixService`
    // for its resource resolver (`commentsService.ts:22`), so a static call
    // back would close a real cycle — the hazard the notebooks entry names.
    // The dynamic import is annotated at each call site with that reason.
    // Deliberately left UNDECLARED for the standing reason: `dependsOn` is a
    // disable-LOCK, and with comments OFF there are no threads to prune, so the
    // branch is vacuous rather than broken — while a lock would wrongly make
    // comments undisableable by three unrelated features.
    // 95 → 96 (ADR 0603 §4 / `PODU-1`, 2026-08-23): `podcasts → documents`. The
    // public episode page had NO text alternative for its audio (WCAG 2.1
    // SC 1.2.1, Level A) — and the transcript already existed, as an ADR 0053
    // Document written by `feature.podcasts.nodes.transcript`. Reading it is the
    // point of the fix. The alternative — copying the transcript into the podcasts
    // store so the read stays in-feature — is the parallel-store defect this repo's
    // no-parallel-architecture law exists to prevent, and it would put the same
    // text in two places with no reconciler. A STATIC import is safe here:
    // `documentsService` does not import podcasts, so no cycle exists (contrast the
    // CMNT-2 entries above, which had to go dynamic for exactly that reason).
    // Precedent: `notebooks/notebooksService.ts:41-44` reads `documentsService`
    // directly and says so in a comment.
    // Deliberately left UNDECLARED for the standing reason: `dependsOn` is a
    // disable-LOCK, and a lock would wrongly make documents undisableable by
    // podcasts. The off case DEGRADES rather than breaks, in both directions.
    //
    // CORRECTED 2026-08-23 (`M1`, ADR 0603 R1) — this justification was FACTUALLY
    // WRONG in both of its halves, and the conclusion it supports was resting on
    // behaviour the code did not have. It used to read: "with documents off, the
    // transcript node's `writeDocument` already returns '' … an episode whose ref
    // was recorded while documents was ON still resolves, because the service layer
    // has no toggle gate."
    //   1. `writeDocument` returned `''` only when the surface was ABSENT. A
    //      DISABLED toggle does not remove the method — `host/featureSurfaces.ts`
    //      WRAPS it and throws `host_capability_disabled` per call — so the awaited
    //      call REJECTED, the node threw, and `failEpisode` never ran. The cited
    //      test pinned the MISSING-REF case, not the documents-OFF case, which was
    //      unpinned entirely. The node now catches exactly that code and returns
    //      `''`, which is what this comment always claimed.
    //   2. "still resolves … no toggle gate" was true and was a DEFECT, not a
    //      degradation: a tenant that disabled `documents` still had its document
    //      content served on an UNAUTHENTICATED, `public`-cached route, bypassing
    //      the gate whose stated purpose is that a feature's data is not read for a
    //      tenant that disabled it. `getPublicEpisodeTranscript` now resolves the
    //      `documents` toggle itself (the `features/strategy/routes.ts` precedent).
    // Both directions are now genuinely honoured, and both are PINNED:
    // `test/podcasts-generation-pipeline.test.ts` § "M1 — a DISABLED `documents`
    // toggle degrades" and `test/podcasts-public-transcript.test.ts` § "`M1`
    // -elevated" / "an episode with NO transcript". The UNDECLARED conclusion is
    // unchanged and still correct — a disable-lock is the wrong instrument for a
    // soft, degrading read — but it now rests on measured behaviour.
    // Considered and rejected: inverting these to a `hostEventDispatcher`
    // subscription so comments listens for deletions instead. It is the tidier
    // graph, but the ADR 0208 runless-event seam is fire-and-forget, and a
    // dropped event here means a permanently orphaned thread with no retry —
    // trading 3 documented soft-read edges for silent data residue. Revisit if
    // the deletion seam ever gains delivery guarantees.
    // 96 → 97 (ADR 0648 D2, 2026-09-10): `crm → consent`. The public-form CRM sink
    // now probes `consent/consentService.isErasureTombstoned` before creating a
    // contact, so an anonymous submit can no longer resurrect a DSAR-erased subject
    // (FRMCD-1 — the first cut checked suppression only, and no erasure path writes
    // a suppression row). Deliberately left UNDECLARED for this file's own reason:
    // `dependsOn` is a disable-LOCK, and the tombstone store is written by
    // `deleteSubject` regardless of the `consent` toggle — a lock would be fiction,
    // and a consent-off tenant must not lose CRM. The read is fail-safe: an
    // unreadable store records `suppression_unreadable`, never a created contact.
    ).toBeLessThanOrEqual(97);
  });
});
