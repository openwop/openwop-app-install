#!/usr/bin/env node
/**
 * gen-feature-deps (ADR 0446) — make cross-feature coupling VISIBLE and honest.
 *
 * Features couple two ways: DECLARED (`BackendFeature.dependsOn`, which feeds the
 * ADR 0194 disable-lock) and, far more often, by direct IMPORT of another feature's
 * internals. The import edges are invisible to the toggle graph. This script scans
 * the real import graph and writes `docs/FEATURE-DEPENDENCIES.md` so the map can
 * never drift from the code.
 *
 * The load-bearing classification (ADR 0446, from the /architect review of the
 * ADR 0439 debt): an undeclared A→B edge is NOT automatically a disable-lock gap.
 * These are SERVICE-LAYER imports, and most target services do NOT gate on their
 * own toggle — so turning B off does not break A, and a `dependsOn` there would be
 * a "lock that can never fire" (the phantom-lock ADR 0439 removed). Each edge is
 * therefore sorted three ways:
 *
 *   [1 PRIMITIVE]  B's imported module is cross-cutting infra (a gate/policy/
 *                  transport/registry), not B's domain → EXTRACT to a host/ seam.
 *   [2 SOFT-READ]  A reads B's domain, but B's SERVICE ignores B's toggle
 *                  (vacuous-when-off) → LEAVE, documented; route via ctx.features
 *                  only if the build-coupling bites. No lock.
 *   [3 HARD-DEP]   A reads B's domain AND B's SERVICE refuses when off → a real
 *                  hard dep → DECLARE dependsOn (break any cycle first).
 *
 * `[3]` is detected structurally (does B's *Service.ts reference its own toggle?);
 * `[1]` is a curated allowlist of known primitives (below) — a judgement the tool
 * records, not guesses. Everything else is `[2]`.
 *
 * `--check` re-generates in memory and exits non-zero if the committed doc is stale
 * (the CI drift gate). Pure Node stdlib.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FD = join(ROOT, 'backend/typescript/src/features');
const DOC = join(ROOT, 'docs/FEATURE-DEPENDENCIES.md');

/**
 * Known cross-cutting PRIMITIVES misfiled inside a feature: `<feature>/<module>` →
 * the seam disposition. An edge importing one of these is category [1]. This is the
 * ADR 0446 disposition register — edits here are architectural decisions, reviewed.
 */
const PRIMITIVES = {
  // CONFIRMED misfiled primitives (cross-cutting infra, not the owner's domain) — extract.
  'billing/entitlementGuard': 'host/entitlementSeam.ts (exists) — route requireEntitledFeature through it (DONE, ADR 0446 D.1)',
  // NB — three edges the coarse "imports a shared module" heuristic first flagged [1] but a
  // per-edge review RECLASSIFIED (ADR 0446 D.3 finding). They are NOT misfiled primitives:
  //   forms/submissionSinks — this is the ADR 0330 inversion working AS DESIGNED. The
  //     integrator (crm/email/…) depends on the primitive (forms) and reads forms' own
  //     `FormDef`/`Submission` domain types to map values→contact. Moving the registry to
  //     host would fight ADR 0330 AND leave the domain-type import in place — no edge retired.
  //     ⇒ [2] (intended integrator→primitive coupling), documented, not extracted.
  //   analytics/identityLinkService — consumers call pure fns, BUT analytics deliberately
  //     OWNS the session concept (the session↔contact link is its domain). Whether that is a
  //     misfiled host identity-floor is an OWNERSHIP decision for a focused ADR, not a
  //     mechanical move. ⇒ [2] until decided.
  //   email/brokeredProvider (D.4) — NOT a pure transport primitive. The real transport spine
  //     (`host/emailAdapter.ts`) is ALREADY in host; brokeredProvider is email's ADAPTER over
  //     it, composing email's `getEmailSettings`/`EmailProvider` domain + connections. Moving
  //     it to host would force a host→email up-import (ADR 0001). commerce/orgs depend on
  //     email's send capability ⇒ [2] domain integration.
//   consent/consentService.isAllowed (D.2) — the ONE genuine policy-gate, but extracting it is
//     UNSAFE. consent is excludable (customer-data-platform bundle) and `isAllowed` DENIES strict
//     categories (marketing.whatsapp, ADR 0394) without explicit opt-in EVEN when consent is off.
//     The direct import build-ENFORCES that consent-dependent features can't ship without consent;
//     a host seam would let a slim build omit consent and default WhatsApp sends permissive — a
//     Meta-compliance regression. The coupling is protective, intended architecture ⇒ [2], keep
//     the direct import. (This is why [1] extraction yielded exactly ONE: entitlement, D.1.)
};

function featureDirs() {
  return readdirSync(FD, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(FD, e.name, 'feature.ts')))
    .map((e) => e.name);
}
function sources(id) {
  const root = join(FD, id);
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); continue; }
      if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}
const isToggleable = (id) => /\btoggleDefault\s*:/.test(readFileSync(join(FD, id, 'feature.ts'), 'utf8'));
function declaredDeps(id) {
  const m = /dependsOn:\s*\[([^\]]*)\]/.exec(readFileSync(join(FD, id, 'feature.ts'), 'utf8'));
  return m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
}
/** Does B's SERVICE layer (any *Service.ts, excluding *Knowledge/*Cache helpers)
 *  reference its own toggle? If yes, B refuses when off ⇒ inbound edges are HARD.
 *
 *  The toggle id may be a string literal OR a const alias (`const TOGGLE_ID = 'x'`),
 *  so the const case is resolved with a one-hop lookup — a literal-only match would
 *  silently mis-classify a const-gated service as soft [2] and HIDE a real hard dep
 *  (the same blind spot the ADR 0419 GATE-4 work fixed). No such service exists in
 *  the tree today, but the check must not become a false-negative when one is added. */
/** Pure: does this ONE service-file's text resolve `id`'s own toggle? Exported so
 *  the const-hop path is unit-testable without a fixture on disk. */
export function textGatesOwnToggle(text, id) {
  // Literal own toggle: resolveOne('<id>', …) or requireFeatureEnabled(req, '<id>', …).
  if (new RegExp(`(?:resolveOne|requireFeatureEnabled)\\([^)]*['"]${id}['"]`).test(text)) return true;
  // Const-aliased own toggle: `const X = '<id>'` … resolveOne(X, …).
  for (const m of text.matchAll(new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"]${id}['"]`, 'g'))) {
    if (new RegExp(`(?:resolveOne|requireFeatureEnabled)\\(\\s*${m[1]}\\b`).test(text)) return true;
  }
  return false;
}
function serviceGatesWhenOff(id) {
  for (const f of sources(id)) {
    if (!/Service\.ts$/.test(f)) continue;
    if (/Knowledge|Cache/.test(f)) continue;
    if (textGatesOwnToggle(readFileSync(f, 'utf8'), id)) return true;
  }
  return false;
}

function computeEdges() {
  const dirs = featureDirs();
  const toggleable = new Set(dirs.filter(isToggleable));
  const declared = new Map(dirs.map((d) => [d, declaredDeps(d)]));
  const hardTarget = new Map([...toggleable].map((b) => [b, serviceGatesWhenOff(b)]));
  const edges = new Map(); // "A->B" → { a, b, modules:Set, dyn, declared }
  for (const a of dirs) {
    for (const f of sources(a)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(from\s*|import\s*\(\s*)['"]\.\.\/([a-z0-9-]+)\/([^'"]+)['"]/g)) {
        const b = m[2];
        if (b === a || !dirs.includes(b)) continue;
        const key = `${a}->${b}`;
        if (!edges.has(key)) edges.set(key, { a, b, modules: new Set(), dyn: false, declared: (declared.get(a) || []).includes(b) });
        edges.get(key).modules.add(m[3].replace(/\.js$/, ''));
        if (m[1].includes('import')) edges.get(key).dyn = true;
      }
    }
  }
  // Edge-level HARD-DEP false-positive overrides (ADR 0446 F). `serviceGatesWhenOff`
  // is FILE-level — it flags a target whose service gates ANYWHERE. But an edge is
  // symbol-level: a consumer importing a PURE helper from that file does not break
  // when the target is off. Reviewed per edge; the reason is the record.
  const HARD_DEP_NOT_REALLY = {
    'service-desk->whatsapp': 'imports the pure parser extractWaInbound; whatsappService self-gates only in its SEND path, which service-desk never calls — so it does NOT break when whatsapp is off ⇒ [2], not a lock',
  };
  // TARGET-level soft override (ADR 0446 F/D.2): the target's service resolves its own
  // toggle, but returns a valid ANSWER rather than breaking the consumer, so the edge is
  // soft. `consent.isAllowed` returns a policy boolean (permissive-when-off for normal
  // categories; strict deny for marketing.whatsapp per ADR 0394) — the consumer never
  // breaks, it acts on the boolean. NB — consent is ALSO the one primitive we deliberately
  // do NOT extract to a seam: it is excludable (customer-data-platform bundle) and the
  // direct import build-enforces that consent-dependent features can't ship without consent;
  // a seam would let a slim build default WhatsApp permissive (a compliance regression).
  const SOFT_TARGET = { consent: 'consent.isAllowed returns a policy boolean (permissive/deny), never breaks the consumer; the direct import is a compliance-protective coupling — do NOT extract (see ADR 0446 D.2)' };
  // TARGET-level file-vs-symbol override (ADR 0446 F, second instance, 2026-08-18): the
  // target's service file resolves its own toggle ONLY inside a lifecycle SUBSCRIBER it
  // registers at module load — never on an EXPORTED function a consumer can call — so
  // the file-level `serviceGatesWhenOff` scan flags it, but no importer breaks when the
  // target is off. `HARD_DEP_NOT_REALLY` is per-EDGE because the fact there was about
  // which symbol the CONSUMER imports; this fact is about the TARGET (the gate is not
  // on its export surface at all), so one entry covers every inbound edge. MEASURED
  // when added: `emailService.ts` has 33 exports and exactly ONE `resolveOne('email')`
  // — `emailFeatureLive()`, a work-avoidance gate for the `onCrmRecordMerged` /
  // `onCrmRecordUnmerged` send-log relink (#3326 CRM-5); every exported send/read
  // function is ungated. If a gate ever lands on an exported function, DELETE the
  // entry — the [3] verdict would then be true and the test below must go red.
  const SUBSCRIBER_ONLY_GATE = { email: 'emailService self-gates ONLY inside its CRM merge-lifecycle subscriber (emailFeatureLive → relink work-avoidance, #3326); all 33 exported send/read functions are ungated, so no consumer breaks when email is off ⇒ [2] (ADR 0446 F file-vs-symbol, target-level)' };
  // Classify.
  for (const e of edges.values()) {
    e.toggleable = toggleable.has(e.b);
    e.alwaysOn = !e.toggleable;
    const prim = [...e.modules].map((mod) => `${e.b}/${mod}`).find((k) => PRIMITIVES[k]);
    if (prim) { e.category = 1; e.disposition = PRIMITIVES[prim]; }
    else if (!e.toggleable) { e.category = 0; e.disposition = 'target is always-on substrate — never a lock (ADR 0439)'; }
    else if (hardTarget.get(e.b) && !HARD_DEP_NOT_REALLY[`${e.a}->${e.b}`] && !SOFT_TARGET[e.b] && !SUBSCRIBER_ONLY_GATE[e.b]) { e.category = 3; e.disposition = 'target service refuses when off — a real hard dep; declare dependsOn (break cycle first)'; }
    else if (hardTarget.get(e.b)) { e.category = 2; e.disposition = HARD_DEP_NOT_REALLY[`${e.a}->${e.b}`] || SOFT_TARGET[e.b] || SUBSCRIBER_ONLY_GATE[e.b]; }
    else { e.category = 2; e.disposition = 'domain read; target vacuous-when-off — leave documented / ctx.features if coupling bites'; }
  }
  return { edges: [...edges.values()], hardTarget };
}

function render() {
  const { edges } = computeEdges();
  const undeclared = edges.filter((e) => !e.declared && e.toggleable);
  const byCat = (c) => undeclared.filter((e) => e.category === c).sort((x, y) => x.b.localeCompare(y.b) || x.a.localeCompare(y.a));
  const cat = { 1: byCat(1), 2: byCat(2), 3: byCat(3) };
  const alwaysOn = edges.filter((e) => !e.declared && e.alwaysOn).length;
  const declaredCount = edges.filter((e) => e.declared).length;

  const row = (e) => `| \`${e.a}\` | \`${e.b}\` | ${e.dyn ? 'dyn' : 'static'} | ${[...e.modules].slice(0, 4).join(', ')} | ${e.disposition} |`;
  const section = (n, title, list) => list.length === 0 ? `### ${title}\n\n_None._\n` :
    `### ${title} (${list.length})\n\n| From | Imports | Kind | Module(s) | Disposition |\n|---|---|---|---|---|\n${list.map(row).join('\n')}\n`;

  return `<!-- GENERATED by scripts/gen-feature-deps.mjs — do not edit by hand. Run \`node scripts/gen-feature-deps.mjs\`. -->
# Feature dependency map

> The real cross-feature coupling in \`backend/typescript/src/features/*\`, regenerated
> from source. Not hand-maintained — CI (\`ci:feature-deps\`) fails if this drifts.
> Method + the three-way classification: **ADR 0446**.

## Summary

| Bucket | Count | Meaning |
|---|---|---|
| Declared (\`dependsOn\`) | ${declaredCount} | real hard deps, disable-lock active |
| Undeclared → always-on target | ${alwaysOn} | correctly undeclared — an always-on dep can never lock (ADR 0439) |
| **[1] Primitive** (undeclared → toggleable) | **${cat[1].length}** | misfiled cross-cutting infra → **extract to a \`host/\` seam** |
| **[2] Soft-read** (undeclared → toggleable) | **${cat[2].length}** | domain read, target vacuous-when-off → **leave documented** (no lock) |
| **[3] Hard-dep** (undeclared → toggleable) | **${cat[3].length}** | target refuses when off → **declare \`dependsOn\`** |

The goal (ADR 0446) is **not** "drive the total to zero." It is: extract the **[1]**
primitives (a real ownership fix), declare the **[3]** hard deps (a real lock), and
leave **[2]** as documented internal reads — declaring those would add locks that can
never fire, the anti-pattern ADR 0439 removed.

## [1] Misfiled primitives → extract to a core seam

${section(1, 'Extract these', cat[1]).split('\n').slice(1).join('\n')}
## [2] Soft domain reads → leave documented (no lock)

${section(2, 'Tolerated internal reads', cat[2]).split('\n').slice(1).join('\n')}
## [3] Hard deps → declare \`dependsOn\`

${section(3, 'Declare these', cat[3]).split('\n').slice(1).join('\n')}
`;
}

// Not a raw `argv[1]` comparison — that is false through a symlink, so the
// generator silently produces nothing (#3070 class; see lib/entry-module.mjs).
const isMain = isEntryModule(import.meta.url);
if (isMain) {
  const out = render();
  if (process.argv.includes('--check')) {
    const cur = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
    if (cur !== out) {
      console.error('check-feature-deps: docs/FEATURE-DEPENDENCIES.md is STALE. Run: node scripts/gen-feature-deps.mjs');
      process.exit(1);
    }
    console.log('check-feature-deps: ok — the dependency map matches the source.');
  } else {
    writeFileSync(DOC, out);
    console.log(`gen-feature-deps: wrote ${DOC.replace(ROOT + '/', '')}`);
  }
}

export { computeEdges, render };
