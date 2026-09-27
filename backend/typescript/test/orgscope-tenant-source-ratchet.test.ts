/**
 * ADR 0508 structural ratchet — an org-scope-gated handler must take its tenant from
 * the GATE, never re-derive it from `user.tenantId`.
 *
 * `user.tenantId` is the caller's HOME tenant. `requireOrgScope` authorizes against
 * the ACTIVE tenant. While those two were allowed to drift, every org-scoped feature
 * route 404'd inside every shared `ws:` workspace — and the naive fix turned that
 * fail-closed 404 into a cross-tenant WRITE. The invariant that prevents both is
 * simply: in a gated module, the tenant comes from one place.
 *
 * A behavioural test cannot hold this. `test/orgscope-shared-workspace.test.ts`
 * proves the property for the routes it exercises; nothing stops the 56th module
 * from reintroducing `user.tenantId` on a route no test covers — which is exactly
 * how the original defect survived from #70. This is the no-growth gate.
 *
 * COMMENTS ARE STRIPPED BEFORE COUNTING. A prior ratchet in this repo counted
 * comment text as code, reddening the build for the commit that FIXED the defect and
 * inflating its own baseline. Prose about `user.tenantId` — including this docblock —
 * must not register.
 *
 * CRM-1 CORRECTION (2026-08-17) — this gate was STRUCTURALLY BLIND to the shape the
 * biggest offender uses, and passed green over 173 live sites.
 *
 * Two independent holes, both now closed:
 *
 *   1. It matched `<binding>.tenantId` with a negative lookbehind that DELIBERATELY
 *      excluded a leading dot, justified as *"`ctx.user.tenantId` is a DIFFERENT
 *      construct — a run/tool context, not the gate's caller"*. That is true for a
 *      run context and FALSE for a gated route module: when `ctx` is bound from
 *      `authorizeOrgScope`, `ctx.user.tenantId` is precisely the HOME tenant the
 *      invariant forbids — and `ctx.tenantId` (the gate's ACTIVE tenant) sits right
 *      beside it. So the exclusion is now conditional on WHERE the binding came
 *      from, not on the spelling.
 *   2. Its binding discovery learned only DESTRUCTURED names
 *      (`const { user } = await authorizeOrgScope(…)`). Every module that keeps the
 *      whole gate result (`const ctx = await authorizeOrgScope(…)`, and the wrapper
 *      form `const authorize = (req, s) => authorizeOrgScope(…)`) was invisible.
 *
 * So there are now TWO binding classes, policed differently:
 *   • CALLER bindings — a `User` object (`const { user } = gate(…)`,
 *     `const caller = await resolveCallerUser(…)`) → `<name>.tenantId` is a
 *     re-derivation.
 *   • GATE-RESULT bindings — the whole `{ user, orgId, tenantId }` object
 *     (`const ctx = await authorizeOrgScope(…)`) → `<name>.user.tenantId` is the
 *     re-derivation; `<name>.tenantId` is the CORRECT source and must never count.
 *
 * MEASURED at the widening: 173 sites across 7 modules. CRM (95) is fixed in the
 * same change and is held at ZERO. The other four modules are recorded in
 * `BASELINE` as a SHRINK-ONLY quarantine — a number that may only fall, never rise,
 * and never a coverage claim. That is a deliberate scope decision, stated rather
 * than hidden: this change does not silently claim commerce/production are clean.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEATURES_DIR = new URL('../src/features/', import.meta.url).pathname;

/** Every `.ts` under `src/features/`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Remove block + line comments and string literals, so only executable code counts. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * Files exempt from the rule, each for a REASON — not a convenience list. Every
 * entry was read and justified individually; a new entry needs the same.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['featureRoute.ts', 'defines the gate itself — `user.tenantId` is its input, not a re-derivation'],
  ['cmsScope.ts', 'the CmsScopeCtx type + the system-site branch, whose data tenant is the reserved SYSTEM_SITE_TENANT rather than anything about the caller'],
  [
    'knowledgeRoutes.ts',
    'profile-memory is NOT gate-bound: its handlers resolve the caller directly for PERSONAL profile reads, where the home tenant is the correct and intended source',
  ],
  [
    'scheduled-agent-chats/routes.ts',
    'the `channelCaller` helper is CHANNEL-scoped (ADR 0202 D3), membership-gated by getChannel/assertChannelManage — no gate-supplied tenant exists on that path',
  ],
]);

function isExempt(file: string): boolean {
  for (const key of EXEMPT.keys()) if (file.endsWith(key)) return true;
  return false;
}

/** The gate entry points. A local wrapper that RETURNS one of these is discovered
 *  transitively (`const authorize = (req, s) => authorizeOrgScope(…)`), because a
 *  wrapper is how three of the seven offending modules bind their context. */
const GATES = 'authorizeOrgScope|requireOrgScope|requireCmsScope';

/**
 * SHRINK-ONLY quarantine (CRM-1). Modules the WIDENED matcher exposed, recorded at
 * their measured count so this gate can land without being blocked on them. A number
 * here may only FALL. It is debt, never coverage — each of these modules still runs
 * its handlers against the caller's HOME tenant.
 *
 * FOLD-IN M2 — "shrink-only" was enforced on the NUMBERS and not on MEMBERSHIP.
 * Nothing asserted the map's size or its keys, so the cheapest way past this gate
 * was to append a line: a newly-offending module could quarantine ITSELF and go
 * green, which is precisely the growth the name promises to prevent. The membership
 * is now pinned below (`QUARANTINED`), so adding an entry fails until someone
 * deliberately edits the pin — a decision, not a side effect. Values are NOT pinned:
 * they must stay free to fall.
 */
// GC-5 / ADR 0508 quarantine DRAINED — all four modules (crm, commerce/ucp,
// commerce/ucpBuyer, production, commerce) migrated off the caller's HOME tenant to
// the gate-provided ACTIVE tenant. The quarantine is now EMPTY: the anti-vacuity
// test below still proves the matcher fires on the shape it polices, so an empty
// baseline is a live zero-tolerance gate, not a disabled one.
const BASELINE: ReadonlyMap<string, number> = new Map([]);

/** M2 — the pinned MEMBERSHIP of the quarantine (sorted). Shrinking a module to
 *  zero removes its BASELINE entry (the stale-ceiling test forces that), which
 *  means removing it here too; ADDING one is what this pin refuses. */
const QUARANTINED: readonly string[] = [];

interface Scan { caller: Set<string>; gate: Set<string>; count: number }

/** The one CALLER binding that is seeded rather than discovered — and therefore the
 *  one that must never be removed by binding discovery (fold-in M1). */
const SEEDED_CALLER = 'user';

/** The whole matcher, as ONE function, so the anti-vacuity test exercises exactly
 *  what the gate runs rather than a re-typed approximation of it. */
export function scanForHomeTenantDerivation(rawSource: string): Scan {
  const code = stripComments(rawSource);

  // CALLER bindings — an identifier holding a `User`. `<name>.tenantId` is the HOME
  // tenant. GC-8: key on the BINDING, not the spelling — reverting `documents/routes.ts`
  // to `caller.tenantId` (the exact ADR 0508 defect) once left this gate 3/3 green.
  const caller = new Set<string>([SEEDED_CALLER]);
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*await\s+resolveCallerUser\s*\(/g)) caller.add(m[1]!);
  for (const m of code.matchAll(new RegExp(`const\\s*\\{[^}]*\\buser\\b\\s*(?::\\s*(\\w+))?[^}]*\\}\\s*=\\s*await\\s+(?:${GATES})\\s*\\(`, 'g'))) {
    if (m[1]) caller.add(m[1]);
  }

  // GATE-RESULT bindings — an identifier holding the whole `{ user, orgId, tenantId }`.
  // Discovered transitively through local wrappers, to a fixpoint: two of the four
  // quarantined modules and CRM itself bind through a one-line `authorize` helper, and
  // a matcher that only knew the three entry-point names could not see any of them.
  const gateFns = new Set<string>(GATES.split('|'));
  // Enumerate function DECLARATIONS once, then test each one's own window — never a
  // single combined regex over the file. A combined regex silently loses overlapping
  // matches: `const FEATURE = {…}` two lines above the real wrapper consumed the
  // gate call, and the wrapper was never discovered (MEASURED — ucpBuyer scanned
  // as clean while carrying 9 offences).
  const decls = [...code.matchAll(/const\s+(\w+)\s*=\s*(?:async\s+)?[<(]|function\s+(\w+)\s*[<(]/g)];
  for (let pass = 0; pass < 3; pass += 1) {
    const known = new RegExp(`\\b(?:${[...gateFns].join('|')})\\s*\\(`);
    for (const m of decls) {
      const name = m[1] ?? m[2];
      if (!name || gateFns.has(name)) continue;
      if (known.test(code.slice(m.index, m.index + 700))) gateFns.add(name);
    }
  }
  const gate = new Set<string>();
  for (const fn of gateFns) {
    for (const m of code.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*await\\s+${fn}\\s*\\(`, 'g'))) gate.add(m[1]!);
  }
  // A name cannot be both; the gate-result reading wins (it is the stricter one) —
  // EXCEPT for the seeded `user`, which is not a discovered binding at all.
  //
  // FOLD-IN M1 — a file-wide SUPPRESSION vector. `caller` is seeded with `'user'`
  // unconditionally, because `const { user } = await gate(…)` is the dominant shape
  // and destructuring gives the name away for free. But this loop then deleted any
  // name that ALSO appeared as a whole-object gate binding — so ONE
  // `const user = await authorizeOrgScope(…)` anywhere in a file un-policed EVERY
  // `user.tenantId` in that same file. MEASURED on a fixture carrying three genuine
  // destructured offences plus one such binding: 3 → 0. Before the CRM-1 widening
  // `user` was policed unconditionally, so the repair introduced a hole wider than
  // the one it closed.
  //
  // The seeded name is now never deleted. The cost is a deliberate false positive:
  // a module that binds the whole gate result to the name `user` will be flagged on
  // `user.tenantId` even though that spelling is correct THERE. That is the right
  // trade — the shape is indistinguishable from the defect at a glance for a human
  // reviewer too, and no module in the tree uses it (measured: repo-wide offender
  // counts are byte-identical with and without this change).
  for (const g of gate) if (g !== SEEDED_CALLER) caller.delete(g);

  // L2 — `?.` is a plausible spelling of the same defect (`ctx.user?.tenantId`,
  // `caller?.tenantId`) and was invisible to a matcher that only knew `.`.
  const dot = '\\??\\.';
  let count = 0;
  for (const name of caller) count += code.match(new RegExp(`(?<![.\\w])${name}${dot}tenantId\\b`, 'g'))?.length ?? 0;
  // For a gate-result binding it is `<name>.user.tenantId` that re-derives HOME —
  // `<name>.tenantId` is the gate's ACTIVE tenant and is the CORRECT source.
  for (const name of gate) count += code.match(new RegExp(`(?<![.\\w])${name}${dot}user${dot}tenantId\\b`, 'g'))?.length ?? 0;
  return { caller, gate, count };
}

function scanRepo(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walk(FEATURES_DIR)) {
    const raw = readFileSync(file, 'utf8');
    // JS-DEBT-2 — select from STRIPPED source, not raw text: a file used to
    // land in scope merely by NAMING a gate in prose that explains why it
    // must not use one (autopilot/routes.ts sat behind a whole-file
    // exemption for exactly this, which was JS-DEBT-3's hazard — that
    // exemption would have hidden a genuinely org-gated handler added
    // later). The gate's own header already declared "COMMENTS ARE
    // STRIPPED BEFORE COUNTING"; now selection honors it too.
    const code = stripComments(raw);
    if (!new RegExp(`\\b(${GATES})\\b`).test(code)) continue;
    if (isExempt(file)) continue;
    const { count } = scanForHomeTenantDerivation(raw);
    if (count > 0) counts.set(file.replace(FEATURES_DIR, ''), count);
  }
  return counts;
}

describe('ADR 0508 — org-scoped handlers take their tenant from the gate', () => {
  it('no gated module re-derives the tenant from the CALLER, whatever it is named', () => {
    const counts = scanRepo();
    const offenders = [...counts.entries()]
      .filter(([f]) => !BASELINE.has(f))
      .map(([f, n]) => `${f} (${n})`);

    expect(
      offenders,
      `These org-scope-gated modules re-derive the tenant from the caller's HOME tenant.\n`
        + `Take it from the gate instead:  const { orgId, tenantId } = await authorizeOrgScope(...)\n`
        + `If a module is genuinely not gate-bound, add it to EXEMPT with the reason.\n\n`
        + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the quarantined modules only ever SHRINK (and CRM is not among them)', () => {
    const counts = scanRepo();
    const grown: string[] = [];
    for (const [file, ceiling] of BASELINE) {
      const now = counts.get(file) ?? 0;
      if (now > ceiling) grown.push(`${file}: ${now} > baseline ${ceiling}`);
    }
    expect(grown, 'Quarantined ADR 0508 debt may only shrink — lower the baseline, never raise it.').toEqual([]);

    // The whole point of the widening: CRM must be at zero, not quarantined.
    for (const file of counts.keys()) {
      expect(file.startsWith('crm/'), `${file} re-derives the HOME tenant — CRM is held at zero`).toBe(false);
    }
  });

  it('the quarantine cannot GROW — its membership is pinned, not just its numbers (M2)', () => {
    // The shrink-only test above compares each entry to its own ceiling, so a
    // NEW entry is compared to a ceiling it brought with it and passes trivially:
    // the cheapest route past this whole gate was to append one line. Pinning the
    // membership makes that an explicit, reviewable edit.
    expect(
      [...BASELINE.keys()].sort(),
      'A module added to BASELINE must also be added to QUARANTINED — quarantining yourself must be a decision, not a side effect.',
    ).toEqual([...QUARANTINED].sort());
    expect(BASELINE.size, 'the quarantine has a fixed membership').toBe(QUARANTINED.length);
  });

  it('a BASELINE entry that has reached zero is removed (a stale ceiling hides a regression)', () => {
    const counts = scanRepo();
    const settled = [...BASELINE.keys()].filter((f) => (counts.get(f) ?? 0) === 0);
    expect(
      settled,
      'These modules are clean — delete their BASELINE entry so a re-introduction fails the gate.',
    ).toEqual([]);
  });

  it('the ratchet can actually see an offender (anti-vacuity)', () => {
    // A file-scanning gate that matches nothing passes forever. Prove the matcher
    // fires on the exact shape it polices, and that comment-stripping does not
    // swallow real code. Each case below discriminates ONE thing; a single sabotage
    // proves a single assertion.

    // (a) the destructured form.
    expect(scanForHomeTenantDerivation(
      'const { user } = await authorizeOrgScope(req, F, s);\nawait listX(user.tenantId, orgId);',
    ).count).toBe(1);

    // (b) GC-8 — the RENAMED caller form, which is what actually slipped through
    // once: a scan that only knows the word `user` is defeated by a one-word rename.
    const renamed = scanForHomeTenantDerivation(
      'const caller = await resolveCallerUser(req);\nawait getX(caller.tenantId, id);',
    );
    expect(renamed.caller.has('caller'), 'the scan must discover renamed caller bindings').toBe(true);
    expect(renamed.count, 'a renamed caller binding must still be caught').toBe(1);

    // (c) CRM-1 — the WHOLE-OBJECT gate binding. This is the shape that hid 173
    // sites: the old matcher required no leading dot, so `ctx.user.tenantId` was
    // excluded BY DESIGN even when `ctx` came straight from the gate.
    const whole = scanForHomeTenantDerivation(
      'const ctx = await authorizeOrgScope(req, F, s);\nawait listX(ctx.user.tenantId, ctx.orgId);',
    );
    expect(whole.gate.has('ctx'), 'the scan must discover whole-object gate bindings').toBe(true);
    expect(whole.count, 'a gate-result binding re-deriving via .user.tenantId must be caught').toBe(1);

    // (d) CRM-1 — bound through a LOCAL WRAPPER, which is how CRM, production and
    // ucpBuyer all bind. A matcher that only knows the three entry-point names sees
    // nothing here.
    const wrapped = scanForHomeTenantDerivation(
      'const authorize = (req: Request, s: Scope): Promise<Ctx> => authorizeOrgScope(req, F, s);\n'
      + "const ctx = await authorize(req, 'workspace:read');\nawait listX(ctx.user.tenantId);",
    );
    expect(wrapped.count, 'a wrapper-bound gate result must still be caught').toBe(1);

    // (e) the CORRECT shape must NOT count — otherwise the gate would red the very
    // commit that fixes it, which is how a prior ratchet in this repo inflated its
    // own baseline.
    expect(scanForHomeTenantDerivation(
      'const ctx = await authorizeOrgScope(req, F, s);\nawait listX(ctx.tenantId, ctx.orgId);',
    ).count).toBe(0);

    // (f) ...and neither does prose, nor a genuine run/tool context (no gate
    // binding named `ctx` exists in this snippet, so the exclusion still holds).
    expect(scanForHomeTenantDerivation('// user.tenantId in a comment').count).toBe(0);
    expect(scanForHomeTenantDerivation(
      'const { user } = await authorizeOrgScope(req, F, s);\nawait f(ctx.user.tenantId);',
    ).count).toBe(0);

    // (g) FOLD-IN M1 — the file-wide SUPPRESSION vector. Three genuine offences on
    // the seeded `user` binding, plus ONE whole-object gate binding that happens to
    // be named `user`. The shipped matcher deleted the seeded name and scored this
    // file 0/3; the seeded name is now never deleted. This case discriminates ONLY
    // the suppression — it says nothing about the other five shapes above.
    const suppressed = 'const { user } = await authorizeOrgScope(req, F, s);\n'
      + 'await a(user.tenantId);\nawait b(user.tenantId);\nawait c(user.tenantId);\n'
      + 'const user = await authorizeOrgScope(req, F, s);\n';
    expect(
      scanForHomeTenantDerivation(suppressed).count,
      'one whole-object gate binding named `user` must not un-police every user.tenantId in the file',
    ).toBe(3);

    // (h) L2 — optional chaining is a plausible spelling of the same defect and was
    // invisible. Both binding classes, one assertion each.
    expect(scanForHomeTenantDerivation(
      'const { user } = await authorizeOrgScope(req, F, s);\nawait f(user?.tenantId);',
    ).count, 'caller?.tenantId is the same re-derivation').toBe(1);
    expect(scanForHomeTenantDerivation(
      'const ctx = await authorizeOrgScope(req, F, s);\nawait f(ctx.user?.tenantId);',
    ).count, 'gate?.user?.tenantId is the same re-derivation').toBe(1);
  });

  it('CRM is actually IN SCOPE of this gate (the blind-spot tripwire)', () => {
    // CRM passed this ratchet green with 95 live offences, because the matcher
    // could not see its shape. If a future edit makes a CRM module invisible again
    // — a renamed gate, a moved binding — this fails rather than going quiet.
    //
    // FOLD-IN M2 — the tripwire covered `crm/orgRoutes.ts` ALONE, so the other two
    // gated CRM modules could go dark without a sound. Each named module is probed
    // independently: its gate binding must be discovered, and the offending shape
    // INJECTED INTO THAT REAL FILE must move the count by exactly one (which is what
    // proves the matcher is live in that file, rather than returning the same number
    // twice).
    const GATED_CRM_MODULES: readonly [string, string][] = [
      ['orgRoutes.ts', 'ctx'],
      ['routes.ts', 'ctx'],
      ['gmailSyncRoutes.ts', 'ctx'],
    ];
    for (const [file, binding] of GATED_CRM_MODULES) {
      const src = readFileSync(join(FEATURES_DIR, 'crm', file), 'utf8');
      const { gate, count } = scanForHomeTenantDerivation(src);
      expect(gate.has(binding), `crm/${file} must expose its gate-result binding '${binding}' to the scan`).toBe(true);
      expect(
        scanForHomeTenantDerivation(`${src}\nawait listX(${binding}.user.tenantId);`).count,
        `the matcher must be LIVE inside crm/${file}`,
      ).toBe(count + 1);
    }
  });

  it('every EXEMPT entry still exists and still carries a reason', () => {
    // An exemption for a deleted or renamed file is silent rot — it would mask a
    // future offender with the same basename.
    const all = walk(FEATURES_DIR);
    for (const [key, reason] of EXEMPT) {
      expect(reason.length, `EXEMPT['${key}'] needs a real justification`).toBeGreaterThan(20);
      expect(all.some((f) => f.endsWith(key)), `EXEMPT names '${key}', which no longer exists`).toBe(true);
    }
  });
});
