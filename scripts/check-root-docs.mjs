#!/usr/bin/env node
/**
 * check-root-docs — the repo root holds adopter deliverables ONLY.
 *
 * Steward grading/tracking reports live in `docs/steward/`, which
 * `build-whitelabel-zip.sh` strips wholesale and `publish-install-repo.sh`
 * therefore never pushes to the PUBLIC openwop/openwop-app-install repo. A
 * report written to the ROOT instead is shipped to adopters.
 *
 * This runs in `npm run ci` because release time is too late to find out. The
 * bundle build already enforces the same allowlist, but it only runs when
 * cutting a release — the root doc has been on main for days by then. Within
 * hours of the relocation (#2722) a peer's /upgrade-ux run landed
 * `UX_UPGRADE-chat-deployment.md` at the root (#2724), from a branch cut before
 * the skill knew the new home. That is the failure this catches, and it will
 * keep happening: skills get updated, in-flight branches do not.
 *
 * Keep ALLOWED in sync with WHITELABEL_ROOT_MD_KEEP in build-whitelabel-zip.sh
 * (plus the two agent-harness files, which stay at the root to be found but are
 * stripped from the bundle). The parity between the two lists is asserted below.
 *
 * Usage:  node scripts/check-root-docs.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Shipped to adopters (must match the bundle's allowlist).
const DELIVERABLES = [
  'README.md', 'CHANGELOG.md', 'RELEASES.md', 'ROADMAP.md',
  'ARCHITECTURE.md', 'DESIGN.md', 'FEATURES.md', 'conformance.md',
  'DEPLOY.md', 'DEPLOY-SMOKE.md',
  'OPENWOP-SYNC.md', 'OPENWOP-WHATSAPP.md',
]
// Agent-harness meta: must sit at the root to be discovered, stripped from the bundle.
const HARNESS = ['CLAUDE.md', 'AGENTS.md']
const ALLOWED = new Set([...DELIVERABLES, ...HARNESS])

const found = readdirSync(ROOT).filter((f) => f.endsWith('.md'))
const strays = found.filter((f) => !ALLOWED.has(f)).sort()

// The two allowlists must not drift apart: a deliverable added here but not to
// the bundle script would be stripped from the bundle, and vice versa.
const bundle = readFileSync(join(ROOT, 'scripts/build-whitelabel-zip.sh'), 'utf8')
const block = bundle.match(/WHITELABEL_ROOT_MD_KEEP=\(([\s\S]*?)\)/)
const bundleList = block ? (block[1].match(/[\w.-]+\.md/g) ?? []) : []
const missingFromBundle = DELIVERABLES.filter((f) => !bundleList.includes(f))
const missingFromHere = bundleList.filter((f) => !DELIVERABLES.includes(f))

let failed = false

if (strays.length) {
  failed = true
  console.error('check-root-docs: FAILED — non-deliverable markdown at the repo root.\n')
  for (const f of strays) console.error(`    ${f}`)
  console.error('\n  Steward reports (grades, audits, sweeps, upgrade plans, trackers) belong in')
  console.error('  docs/steward/ — that directory is stripped from the white-label bundle, so a')
  console.error('  report at the root is published to adopters instead. Move it:')
  // The remedy must not be able to destroy a file. `git mv X docs/steward/`
  // OVERWRITES docs/steward/X when it already exists, silently — and it nearly did:
  // the stray `TODO.md` that motivated this guard would have clobbered the 98KB
  // `docs/steward/TODO.md`, an unrelated document. A tool's printed remedy carries
  // the tool's authority, so it has to be safe to paste.
  const target = join(ROOT, 'docs/steward', strays[0])
  if (existsSync(target)) {
    console.error(`\n    # docs/steward/${strays[0]} ALREADY EXISTS and is a different document.`)
    console.error(`    # Moving onto it would overwrite it. Pick a distinct name:`)
    console.error(`    git mv ${strays[0]} docs/steward/<distinct-name>.md\n`)
  } else {
    console.error(`\n    git mv ${strays[0]} docs/steward/\n`)
  }
  console.error('  If it genuinely IS an adopter deliverable, add it to ALLOWED here AND to')
  console.error('  WHITELABEL_ROOT_MD_KEEP in scripts/build-whitelabel-zip.sh.')
}

if (missingFromBundle.length || missingFromHere.length) {
  failed = true
  console.error('\ncheck-root-docs: FAILED — this allowlist and the bundle allowlist have drifted.')
  if (missingFromBundle.length) console.error(`  in this script but not the bundle: ${missingFromBundle.join(', ')}`)
  if (missingFromHere.length) console.error(`  in the bundle but not this script: ${missingFromHere.join(', ')}`)
}

if (failed) process.exit(1)
console.log(`check-root-docs: ok — ${found.length} root doc(s), all classified.`)
