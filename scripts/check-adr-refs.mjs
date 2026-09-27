#!/usr/bin/env node
/**
 * check-adr-refs — every `ADR NNNN` citation resolves to a docs/adr/NNNN-*.md
 * file (CRMGAP-17). Two real incidents motivated this: a cross-branch ADR
 * renumber left main-side DESIGN.md rows citing the wrong numbers, and a
 * merged doc cited a research baseline that wasn't committed — both were
 * caught by hand-review only. This is the mechanical version.
 *
 * Scans tracked text sources (docs/, backend + frontend src, packs/,
 * examples/, the root *.md files). Excludes archives (historical numbers may
 * legitimately predate renumbers) and lockfiles. Exits 1 on any dangling ref.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

// ── `--next` / `--reserve <slug>` (DEBT-4) ────────────────────────────────────
//
// Picking a number from `readdirSync('docs/adr')` is what keeps colliding: the
// working tree cannot see an ADR sitting on a peer's UNMERGED branch. One session
// was renumbered THREE times in a day (0523 → 0524 → 0530), each costing a rebase
// and a full ~12-minute gate run, and the prose policy this file's header
// describes had already failed twice before that (0493, 0494).
//
// So scan ALL REFS, not the tree. `git log --all` over `docs/adr/*.md` sees every
// ADR that has ever existed on any branch this clone has fetched — exactly the
// set a directory listing misses.
//
// CORRECTED 2026-09-15 — this said `git log --all --diff-filter=A`, and the
// filter was the bug. See `numbersAcrossAllRefs` below: a renumber is a rename,
// a rename is not an add, and so the scan was blind to precisely the sessions
// that were already renumbering to avoid a collision.
//
//   node scripts/check-adr-refs.mjs --next             → print the next free number
//   node scripts/check-adr-refs.mjs --reserve <slug>   → create the placeholder
//
// This SHRINKS the race, it does not eliminate it: two sessions asking within the
// same seconds still tie, and a peer's number stays invisible until fetched. That
// residual is acceptable — seconds instead of the whole time you spend
// implementing — and the duplicate check below remains the backstop.
function numbersAcrossAllRefs() {
  const used = new Set();
  for (const f of readdirSync('docs/adr')) {
    const m = /^(\d{4})-/.exec(f);
    if (m) used.add(Number(m[1]));
  }
  try {
    // NO `--diff-filter`. It used to say `A` (added), and A IS NOT THE QUESTION.
    //
    // A renumber is a `git mv`, which git records as a RENAME, and a rename is
    // not an add — so every renumbered ADR was INVISIBLE to `--next`. That made
    // the sessions MOST likely to collide (the ones already renumbering to avoid
    // a collision) the ones the tool could not see, which is how two collisions
    // happened within ninety minutes on 2026-09-15 and why BOTH were renumbers
    // rather than first claims.
    //
    // MEASURED, both of that day's renumbers:
    //   ad4d4887d  R098  docs/adr/0691-kicktodo-… -> docs/adr/0696-kicktodo-…
    //   ce5f81ff2  R082  docs/adr/0696-workspace-… -> docs/adr/0697-workspace-…
    // `--diff-filter=A  | grep -c 0697` -> 0.   `--diff-filter=AR` -> 1.
    //
    // AND THE PROPERTY WAS PERVERSE. Rename detection is a SIMILARITY score, so
    // the more FAITHFULLY you renumber — preserving the ADR's content, changing
    // only the number — the higher the score and the more certainly the file is
    // classified a rename and dropped. A sloppy renumber that rewrote the body
    // could fall below the threshold and be counted correctly. The tool rewarded
    // the wrong behaviour.
    //
    // `AR` would fix the measured case and leave the next variant open (a copy, a
    // `D`+`A` pair split across commits, whatever git classifies next). The
    // question this set asks is "has this NUMBER ever existed?", and ANY commit
    // touching `docs/adr/NNNN-*.md` answers yes — a modification proves existence
    // exactly as well as an addition. So the filter goes away rather than growing
    // letters: do not ask a filter to prove a negative.
    const out = execSync(
      "git log --all --name-only --pretty=format: -- 'docs/adr/*.md'",
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of out.split('\n')) {
      const m = /docs\/adr\/(\d{4})-/.exec(line.trim());
      if (m) used.add(Number(m[1]));
    }
  } catch {
    // No git, or a shallow clone. Degrade to the directory listing — and SAY SO,
    // rather than silently returning a number that ignores every peer.
    console.error('  (warning: could not read git refs — number reflects the working tree only)');
  }
  return used;
}

const _adrArgv = process.argv.slice(2);
if (_adrArgv[0] === '--next' || _adrArgv[0] === '--reserve') {
  const used = numbersAcrossAllRefs();
  // MAX + 1, never the first GAP. Asking for "the first free number" returned 0090
  // — a hole left by a renumber years ago. Reusing it would attach a brand-new
  // decision to a number that historical commit messages and cross-references may
  // still cite, which is precisely the ambiguity the duplicate check below exists
  // to prevent. ADR numbers are append-only; holes stay holes.
  const padded = String(Math.max(0, ...used) + 1).padStart(4, '0');
  if (_adrArgv[0] === '--next') {
    console.log(padded);
    process.exit(0);
  }
  const slug = (_adrArgv[1] || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error('usage: check-adr-refs.mjs --reserve <kebab-slug>');
    process.exit(2);
  }
  const target = `docs/adr/${padded}-${slug}.md`;
  if (existsSync(target)) { console.error(`x ${target} already exists`); process.exit(1); }
  writeFileSync(target, [
    `# ADR ${padded} — ${slug.replace(/-/g, ' ')}`,
    '',
    'Status: Proposed',
    '',
    '## Context',
    '',
    '_Reserved placeholder. Claiming the number IS the point: it becomes visible to',
    "every other session's `--next` as soon as it is committed. Replace this with the",
    'real decision — an unfilled reservation is worse than no reservation._',
    '',
  ].join('\n'));
  console.log(`reserved ${target}`);
  process.exit(0);
}


const adrFiles = readdirSync('docs/adr');

// One number, one decision. A duplicate slot is invisible to the dangling-ref scan
// below — both files exist, so every `ADR NNNN` citation still "resolves", just
// ambiguously, to two different decisions. Three parallel sessions minting numbers
// against a directory listing collided twice in two days (0493, then 0494); the
// numbering policy was written down in prose and never enforced.
const byNumber = new Map();
for (const f of adrFiles) {
  const n = /^(\d{4})-/.exec(f)?.[1];
  if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
}
// Pre-existing debt, frozen as a baseline. 15 slots were already double-claimed when
// this check was written (the oldest since ADR 0027) and they are cited across docs,
// src and packs — renumbering them is a separate, per-ADR job with citation updates,
// not a drive-by. The ratchet stops the bleeding NOW and the list is the debt register.
// Shrink it; never grow it.
const KNOWN_DUPLICATES = new Set([
  '0027', '0079', '0102', '0178', '0188', '0195', '0200', '0208',
  '0229', '0250', '0292', '0419', '0434', '0490', '0493',
  // 2026-09-21: durability seam (created 09-20 22:29) vs canvas workbench (09-21 07:22),
  // both MERGED and cited in src before either session could see the other's number.
  '0739',
]);

const dupes = [...byNumber.entries()].filter(([, files]) => files.length > 1).map(([n]) => n);
const fresh = dupes.filter((n) => !KNOWN_DUPLICATES.has(n));
// Anti-staleness: a baseline nobody prunes rots into a permanent exemption. If a slot
// was resolved, the entry must go — otherwise it silently re-permits a future collision.
const stale = [...KNOWN_DUPLICATES].filter((n) => !dupes.includes(n)).sort();

if (fresh.length > 0 || stale.length > 0) {
  const highest = Math.max(...[...byNumber.keys()].map(Number));
  if (fresh.length > 0) {
    console.error(`✗ check-adr-refs: ${fresh.length} NEW duplicate ADR number(s):`);
    for (const n of fresh) {
      console.error(`  ADR ${n} is claimed by ${byNumber.get(n).length} files:`);
      for (const f of byNumber.get(n)) console.error(`    docs/adr/${f}`);
    }
    // The fix is mechanical, so name it: policy is first-CREATED wins, and the
    // tie-break is committer date — not the order `readdir` happened to yield.
    // THIS MESSAGE USED TO SAY "renumber the later one", FULL STOP — and it
    // CONTRADICTED `docs/adr/README.md`, which says to RECORD the collision
    // rather than renumber implemented, widely-referenced ADRs. All 15 entries
    // in KNOWN_DUPLICATES were resolved by recording, so practice follows the
    // README; the gate was the outlier. A session that trusts this message over
    // the README churns a peer's merged ADR and its in-code citations — which is
    // exactly what happened on 0519 (2026-08-05) before anyone noticed the two
    // documents disagreed. Name BOTH paths and the discriminator.
    console.error(
      '\n  Establish creation order first — the FIRST-CREATED file keeps the number:\n' +
        '    git log --format=%cI --follow -- docs/adr/<file> | tail -1\n' +
        '    (NOT `--diff-filter=A`: if the file arrived by a RENUMBER it was\n' +
        '     renamed, not added, and that form prints NOTHING — an empty result\n' +
        '     that reads as an answer. `--follow` walks through the rename.)\n\n' +
        '  Then pick the path by whether the LATER ADR has already merged:\n' +
        '    STILL IN AN OPEN PR → renumber it. Next free slot: ' +
        `${String(highest + 1).padStart(4, '0')}\n` +
        '    ALREADY MERGED + referenced in code → do NOT renumber (it rewrites\n' +
        '      history and re-attributes citations across two unrelated decisions).\n' +
        '      Add the number to KNOWN_DUPLICATES below AND a row to\n' +
        '      docs/adr/README.md naming the canonical owner + the collider.\n\n' +
        '  Do NOT reuse a KNOWN_DUPLICATES number — those slots are still contested.\n',
    );
  }
  if (stale.length > 0) {
    console.error(
      `✗ check-adr-refs: ${stale.length} resolved slot(s) still in KNOWN_DUPLICATES: ` +
        `${stale.join(', ')}\n  Remove them — the baseline must only list live debt.\n`,
    );
  }
  process.exit(1);
}

const known = new Set(byNumber.keys());

// TRACKED **AND** UNTRACKED-NOT-IGNORED.
//
// `git ls-files` alone cannot see a file you have not staged yet, and this gate
// is the one most exposed to that: the commonest new file in this repo IS a new
// ADR, and a brand-new ADR citing a number that does not resolve is exactly what
// this check exists to catch. It reported ✓ on the file under validation because
// the file was invisible to it.
//
// MEASURED 2026-09-11, two sessions independently:
//   untracked → ✓ all ADR citations resolve (637 ADRs, 7357 files scanned)
//   git add   → ✗ 1 dangling ADR reference … ADR 9999
// Same file, same content, nothing else changed.
//
// And the file COUNT is not a usable tell. One session saw 7350 → 7351 and read
// the delta as the signal; on another tree the count was 7357 BOTH TIMES,
// because whether the new file lands inside the scanned globs decides whether it
// moves. So "watch the number" fails precisely on the file you were worried
// about. The fix has to be in the enumeration, not in the reader's vigilance.
//
// `--others --exclude-standard` is the right addition rather than a raw tree
// walk: it honours `.gitignore`, so genuinely scratch files stay out while a new
// ADR or source file — the things a human is about to commit — come in.
//
// Related but NOT the same hazard, and worth keeping distinct:
// `check-build-chain-split.mjs` already flags `git ls-files` in the FRONTEND
// BUILD chain, because an adopter unpacks a zip with no `.git` and the call
// returns an empty list — "an empty file list silently passes a gate that should
// have run". Same failure shape, different cause (no working copy vs. not yet
// staged), and this script is outside that detector's scope because it runs from
// `ci.sh` rather than the build chain. Two causes, one class.
const GLOBS = ["'docs/**/*.md'", "'*.md'", "'backend/typescript/src/**'", "'frontend/react/src/**'", "'packs/**'", "'examples/**'"].join(' ');
const listed = (args) => {
  try {
    return execSync(`git ls-files ${args} -- ${GLOBS}`, { encoding: 'utf8' }).split('\n');
  } catch {
    // No working copy (the adopter-zip case above). Return nothing here rather
    // than throwing; the floor below turns an empty result into a REFUSAL, so a
    // missing `.git` cannot masquerade as "nothing to check".
    return [];
  }
};
const tracked = [...new Set([...listed(''), ...listed('--others --exclude-standard')])]
  .filter((f) => f && !f.startsWith('docs/assessments-archive/') && /\.(md|ts|tsx|mjs|js|json)$/.test(f));

// ABSTAIN RATHER THAN PASS on an empty enumeration. Zero files is never a real
// answer in this repo, so it means the enumeration failed — no working copy, a
// glob that stopped matching, a cwd the caller did not expect. Printing ✓ there
// is the same defect this whole comment is about, one level up.
if (tracked.length < 100) {
  console.error(
    `✗ check-adr-refs: enumerated only ${tracked.length} file(s) — below any plausible floor.\n` +
      '  The scan failed; it did not find a clean tree. Refusing to report "all citations resolve"\n' +
      '  from a list that was never built. (No working copy? Wrong cwd? Globs no longer matching?)',
  );
  process.exit(1);
}

const dangling = [];
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const m of text.matchAll(/ADR[  ](\d{4})\b/g)) {
    if (!known.has(m[1])) {
      const line = text.slice(0, m.index).split('\n').length;
      dangling.push(`${file}:${line} — ADR ${m[1]} (no docs/adr/${m[1]}-*.md)`);
    }
  }
}

if (dangling.length > 0) {
  console.error(`✗ check-adr-refs: ${dangling.length} dangling ADR reference(s):`);
  for (const d of dangling.slice(0, 40)) console.error(`  ${d}`);
  process.exit(1);
}
console.log(`✓ check-adr-refs: all ADR citations resolve (${known.size} ADRs, ${tracked.length} files scanned).`);
