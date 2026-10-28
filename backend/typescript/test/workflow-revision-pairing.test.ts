/**
 * ADR 0474 — the revision-pairing ratchet (the `agent-prompt-tool-ids` source-
 * scan pattern): every FILE that registers workflow definitions either appends
 * revisions (`recordRevision`) or is explicitly allowlisted with a reason.
 * A new tenant-content write path cannot silently skip history.
 *
 * The check is per FILE: one `recordRevision(` anywhere in a file pairs every
 * register call in it, and an aliased import (`registerWorkflow as reg`) is not
 * followed. Both are known limits of a source scan, recorded here, not chased.
 *
 * An allowlist entry is stale when its file no longer registers OR when it now
 * records revisions itself (it no longer needs the exemption, and a dead entry
 * would wave through a future unpaired path in that file). Wave 64 measured
 * two such entries (`host/seedWorkflows.ts`, `features/crm/gmailSyncService.ts`,
 * both now calling `recordRevision`) and removed them: 6 → 4, shrink-only.
 *
 * Sabotage that turns it red: removing kbService's `recordRevision` call
 * (8fw5g2-rvp-unpaired-kb), or the compose tool's (-rvp-unpaired-compose);
 * an allowlist entry for a file that no longer registers (-rvp-stale-allow);
 * re-adding a paired file to the allowlist (8fw5g2-rvp-paired-stale-r2).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../src');

/** Files that register definitions WITHOUT revisions, and why that is correct. */
const ALLOWLIST: Record<string, string> = {
  'host/workflowsRegistry.ts': 'the registrar itself',
  'host/workflowAuthorSeed.ts': 'seed/sample defs',
  'host/demoWalkthroughsSeed.ts': 'seed defs + lifecycle-only unarchive',
  // RFC 0142 leg B. Registers a throwaway one-node definition under the
  // conformance-only tenant so the witness can start a REAL run; env-gated and
  // 404 in production. Not tenant content, so there is no history to skip —
  // the same reasoning as the seed entries above, not an exemption for
  // convenience. Added deliberately: this ratchet caught the new call site on
  // its first run, which is the ratchet working.
  'routes/artifactTypeSeam.ts': 'conformance seam — throwaway def under the conformance tenant, env-gated',
};

/** Comments are not code. Both legs matched the RAW text, so a docblock that QUOTES the
 *  retired call (every pin-site drain writes one: "this used to hand a literal to the
 *  raw `registerWorkflow()`") kept a drained module "registering" — five allowlist
 *  entries (agent-knowledge, assistant ×2, scheduled-chat turn, channel turn) were
 *  stale and green that way, measured 2026-10-14 in the KickTodo workflows grade.
 *  Line comments are stripped only after start-of-line or whitespace, so a `//` inside
 *  a URL string is left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const REGISTERS = /\b(registerWorkflow|registerWorkflowDurable|reRegisterWorkflow)\(/;
const RECORDS = /\brecordRevision\(/;

/** src/ read ONCE per file run (both cases share it): rel path → code with
 *  comments and import/re-export lines removed. */
let codeCache: Map<string, string> | null = null;
function sourceCode(): Map<string, string> {
  if (codeCache) return codeCache;
  codeCache = new Map();
  for (const file of walk(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    // Call sites only — strip the import lines so `registerWorkflow as X` doesn't count.
    codeCache.set(relative(SRC, file), text.split('\n').filter((l) => !/^\s*import\b/.test(l) && !/^\s*export \{/.test(l)).join('\n'));
  }
  return codeCache;
}

describe('workflow revision pairing (ADR 0474 ratchet)', () => {
  it('every FILE that registers workflow definitions also calls recordRevision or is allowlisted', () => {
    const offenders: string[] = [];
    for (const [rel, body] of sourceCode()) {
      if (!REGISTERS.test(body)) continue;
      if (!RECORDS.test(body) && !(rel in ALLOWLIST)) offenders.push(rel);
    }
    expect(offenders, `unpaired workflow write path(s) — append recordRevision or allowlist with a reason:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const code = sourceCode();
    const stale = Object.keys(ALLOWLIST).filter((rel) => {
      const body = code.get(rel);
      if (body === undefined) return true; // file gone ⇒ stale
      // No longer registers, or now records revisions itself: either way the exemption is dead.
      return !REGISTERS.test(body) || RECORDS.test(body);
    });
    expect(stale, `allowlist entries no longer registering workflows, or already pairing with recordRevision:\n${stale.join('\n')}`).toEqual([]);
    expect(Object.keys(ALLOWLIST)).toHaveLength(4); // measured 2026-10-24: shrink-only
  });
});
