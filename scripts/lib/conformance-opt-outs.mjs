/**
 * WHD-18 / ADR 0735 — the `OPENWOP_OPTED_OUT_PROFILES` value for a POST-DEPLOY
 * cut, DERIVED from the ledgers the in-process lane already uses, never typed.
 *
 * The honest advertise-or-opt-out ledger lives in
 * `backend/typescript/conformance/run.ts` (`OPTED_OUT_PROFILES`) and, at major 2
 * only, `backend/typescript/conformance/major2Ledger.ts`
 * (`MAJOR2_UNDECLARED_FAMILIES`). The external-target lane in `run.ts` adds
 * `workflowChainPacks.hostExpansionSeam`, because the release image does not
 * ship the devDependency that seam's fixture manifest lives in — and a deployed
 * revision IS a release image, so the same entry applies here.
 *
 * WHY A PARSER AND NOT AN IMPORT. `run.ts` calls `main()` at top level, so
 * importing it RUNS the conformance lane (`major2Ledger.ts`'s docblock records
 * the same trap). And a bash `grep "'…'"` over the file is how the 2026-09-21
 * manual cut got it WRONG: it also caught `'conformance-fixtures'` and
 * `'form-content'` — two path segments from a `resolve(...)` call 400 lines
 * further down — and passed them to the suite as profile opt-outs. So this reads
 * ONLY the lines between the array's opening line and its terminator, and takes
 * a line only when it BEGINS with a quoted id (comment lines, which carry
 * apostrophes like "corpus schema's", never do).
 *
 * `backend/typescript/test/whd18-scripts.test.ts` pins the derivation against
 * the ledgers' own exports (`MAJOR2_UNDECLARED_FAMILIES` is importable) and
 * against the known size of `OPTED_OUT_PROFILES`, so a reformat that makes this
 * parser read nothing reds rather than cutting a bundle with no opt-outs.
 *
 *   node scripts/lib/conformance-opt-outs.mjs --major 2    # prints a,b,c
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryModule } from './entry-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFORMANCE = join(ROOT, 'backend', 'typescript', 'conformance');

/** The external-target lane's extra entry (`run.ts` `runAgainstExternalTarget`). */
export const EXTERNAL_TARGET_EXTRA = 'workflowChainPacks.hostExpansionSeam';

/**
 * The quoted ids of `const <name> = [ … ]` in `source`, one per line.
 * Throws — never returns empty — when the declaration or terminator is missing,
 * or when nothing parses: an empty opt-out list is a different (and wrong) cut,
 * not a smaller one.
 */
export function readConstArray(source, name, file = '<source>') {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(export\\s+)?const\\s+${name}\\s*(:[^=]*)?=\\s*\\[\\s*$`).test(l));
  if (start < 0) throw new Error(`${file}: no \`const ${name} = [\` line — the ledger moved; fix this parser, do not hand-type the list`);
  const ids = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\](\s*as\s+const)?\s*;\s*$/.test(line)) {
      if (ids.length === 0) throw new Error(`${file}: \`${name}\` parsed EMPTY — refusing to cut with no opt-outs`);
      return ids;
    }
    const m = /^\s*'([A-Za-z0-9._-]+)'\s*,?/.exec(line);
    if (m) ids.push(m[1]);
  }
  throw new Error(`${file}: \`${name}\` has no terminator — the ledger moved; fix this parser`);
}

/** A capability family, read the way the suite's `capabilityFamily()` does:
 *  nested under `capabilities` or at the document root. */
function family(doc, name) {
  return doc?.capabilities?.[name] ?? doc?.[name];
}

/**
 * WHD-23 — profiles the in-process lane ADVERTISES (its boot enables them) but
 * the DEPLOYED host deliberately does not. They are major-1 only: the measured
 * 2026-09-21 bundles named exactly these, as "host MUST advertise the <p>
 * profile … or declare opt-out" (32 rows), and none at major 2.
 *
 * NOT derived from "what failed last time". That would absolve a real
 * advertising REGRESSION, a profile production means to serve and silently
 * stopped advertising. Each entry is reviewed and carries the EXACT predicate
 * the suite's own scenario uses for "advertised", and `checkPostureOptOuts`
 * refuses the whole cut if live discovery advertises any of them. An opt-out
 * MUST match what the target does NOT advertise (RFC 0148 §B; the corpus's
 * 2.35.0 verifier rejects the contradiction).
 *
 * `openwop-artifact-type-packs` / `-store` are deliberately ABSENT: production
 * advertises `artifactTypes.supported: true`, and those rows fail because the
 * install/emission test SEAMS are off in production. That is an advertised
 * behaviour the suite cannot observe, an honest red, and opting out of an
 * advertised profile would be a false claim.
 */
export const PRODUCTION_POSTURE_OPT_OUTS = Object.freeze([
  { profile: 'openwop-anonymous-actor', advertised: (d) => family(d, 'anonymousActor')?.supported === true,
    why: 'RFC 0132 anon actor is env-gated OFF in production (OPENWOP_ANON_ACTOR_ENABLED unset)' },
  { profile: 'openwop-workload-identity', advertised: (d) => family(d, 'workloadIdentity')?.supported === true,
    why: 'workload identity is env-gated OFF in production' },
  { profile: 'openwop-workload-identity-delegation', advertised: (d) => family(d, 'workloadIdentity')?.delegation?.supported === true,
    why: 'delegation rides workload identity, OFF in production' },
  { profile: 'openwop-safefetch-live-audit',
    advertised: (d) => family(d, 'httpClient')?.safeFetch?.supported === true && family(d, 'toolHooks')?.prePostEvents === true,
    why: 'toolHooks.prePostEvents is not advertised in production' },
  { profile: 'openwop-selfhosted-providers',
    advertised: (d) => Array.isArray(family(d, 'aiProviders')?.selfHosted) && family(d, 'aiProviders').selfHosted.length > 0,
    why: 'production configures no self-hosted provider' },
  { profile: 'openwop-channel-presence', advertised: (d) => family(d, 'channels')?.presence?.supported === true,
    why: 'the channels family is not advertised in production' },
]);

/**
 * The posture opt-outs, VERIFIED against the target's own discovery document.
 * Throws — refusing the cut — when the target advertises any of them, naming
 * each, because a bundle carrying that contradiction is a false claim in one
 * direction or the other.
 */
export function checkPostureOptOuts(discovery) {
  if (!discovery || typeof discovery !== 'object') {
    throw new Error('no discovery document for the target — the posture opt-outs cannot be checked, so none are applied');
  }
  const contradicted = PRODUCTION_POSTURE_OPT_OUTS.filter((e) => e.advertised(discovery)).map((e) => e.profile);
  if (contradicted.length > 0) {
    throw new Error(
      `the target ADVERTISES ${contradicted.join(', ')} — remove ${contradicted.length === 1 ? 'it' : 'them'} from ` +
        'PRODUCTION_POSTURE_OPT_OUTS (an opt-out must match what the target does NOT advertise)',
    );
  }
  return PRODUCTION_POSTURE_OPT_OUTS.map((e) => e.profile);
}

/** The opt-out list for a post-deploy cut at `major`. With `discovery` (the
 *  TARGET's `/.well-known/openwop`), major 1 also carries the verified
 *  production-posture opt-outs; without it the list is the ledgers alone. */
export function optedOutProfiles(major, root = CONFORMANCE, discovery = undefined) {
  if (major !== 1 && major !== 2) throw new Error(`major must be 1 or 2 (got ${String(major)})`);
  const runTs = join(root, 'run.ts');
  const ledgerTs = join(root, 'major2Ledger.ts');
  const base = readConstArray(readFileSync(runTs, 'utf8'), 'OPTED_OUT_PROFILES', runTs);
  const major2 = major === 2 ? readConstArray(readFileSync(ledgerTs, 'utf8'), 'MAJOR2_UNDECLARED_FAMILIES', ledgerTs) : [];
  const posture = major === 1 && discovery !== undefined ? checkPostureOptOuts(discovery) : [];
  return [...new Set([...base, ...major2, EXTERNAL_TARGET_EXTRA, ...posture])];
}

if (isEntryModule(import.meta.url)) {
  const i = process.argv.indexOf('--major');
  const major = Number(i >= 0 ? process.argv[i + 1] : NaN);
  const j = process.argv.indexOf('--discovery-url');
  try {
    let discovery;
    if (j >= 0) {
      const res = await fetch(process.argv[j + 1], { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`discovery ${process.argv[j + 1]} answered ${res.status}`);
      discovery = await res.json();
    }
    process.stdout.write(`${optedOutProfiles(major, CONFORMANCE, discovery).join(',')}\n`);
  } catch (err) {
    process.stderr.write(`conformance-opt-outs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
