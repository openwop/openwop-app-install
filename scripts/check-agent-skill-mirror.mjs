#!/usr/bin/env node
/**
 * check-agent-skill-mirror — `.agents/skills/` must be a byte-exact mirror of
 * `.claude/skills/`.
 *
 * The repo carries the same skill definitions for two agent harnesses:
 * `.claude/skills/` (Claude Code) and the `.agents/skills/` mirror. Nothing
 * enforced the mirroring, so it rotted — by 2026-08 it was missing 5 skills
 * outright and 11 more had diverged in content. A harness reading the mirror was
 * being handed stale instructions, which is worse than having no mirror at all:
 * it fails silently and looks authoritative.
 *
 * A duplicate with no equality check is a fact nobody is establishing. This is
 * the check.
 *
 * Usage:  node scripts/check-agent-skill-mirror.mjs          (verify; exit 1 on drift)
 *         node scripts/check-agent-skill-mirror.mjs --fix    (re-mirror from .claude/)
 */
import { readdirSync, readFileSync, statSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, '.claude/skills')
const MIRROR = join(ROOT, '.agents/skills')

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

if (process.argv.includes('--fix')) {
  rmSync(MIRROR, { recursive: true, force: true })
  cpSync(SOURCE, MIRROR, { recursive: true })
  console.log('check-agent-skill-mirror: re-mirrored .agents/skills from .claude/skills')
  process.exit(0)
}

if (!existsSync(SOURCE)) {
  console.error('check-agent-skill-mirror: .claude/skills is missing — nothing to mirror from.')
  process.exit(1)
}

const rel = (base) => (f) => relative(base, f)
const sourceFiles = new Set(walk(SOURCE).map(rel(SOURCE)))
const mirrorFiles = new Set(walk(MIRROR).map(rel(MIRROR)))

const missing = [...sourceFiles].filter((f) => !mirrorFiles.has(f)).sort()
const extra = [...mirrorFiles].filter((f) => !sourceFiles.has(f)).sort()
const differing = [...sourceFiles]
  .filter((f) => mirrorFiles.has(f))
  .filter((f) => !readFileSync(join(SOURCE, f)).equals(readFileSync(join(MIRROR, f))))
  .sort()

const problems = missing.length + extra.length + differing.length
if (problems === 0) {
  console.log(`check-agent-skill-mirror: ok — .agents/skills matches .claude/skills (${sourceFiles.size} files).`)
  process.exit(0)
}

console.error('check-agent-skill-mirror: FAILED — .agents/skills has drifted from .claude/skills.\n')
const report = (label, list) => {
  if (!list.length) return
  console.error(`  ${label} (${list.length}):`)
  for (const f of list.slice(0, 20)) console.error(`    ${f}`)
  if (list.length > 20) console.error(`    … and ${list.length - 20} more`)
}
report('missing from the mirror', missing)
report('stale in the mirror (no longer in .claude/skills)', extra)
report('content differs', differing)
console.error('\n  .claude/skills is the source of truth. Fix with:')
console.error('    node scripts/check-agent-skill-mirror.mjs --fix')
process.exit(1)
