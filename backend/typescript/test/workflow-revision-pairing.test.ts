/**
 * ADR 0474 — the revision-pairing ratchet (the `agent-prompt-tool-ids` source-
 * scan pattern): every FILE that registers workflow definitions either appends
 * revisions (`recordRevision`) or is explicitly allowlisted with a reason.
 * A new tenant-content write path cannot silently skip history.
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
  'host/seedWorkflows.ts': 'seed/sample defs — re-seeded idempotently, not tenant history',
  'host/workflowAuthorSeed.ts': 'seed/sample defs',
  'host/demoWalkthroughsSeed.ts': 'seed defs + lifecycle-only unarchive',
  'features/crm/gmailSyncService.ts': 'UNOWNED system instantiation (no ownership row ⇒ no revision lane)',
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

describe('workflow revision pairing (ADR 0474 ratchet)', () => {
  it('every registerWorkflow call site pairs with recordRevision or is allowlisted', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      const text = stripComments(readFileSync(file, 'utf8'));
      // Call sites only — strip the import lines so `registerWorkflow as X` doesn't count.
      const body = text.split('\n').filter((l) => !/^\s*import\b/.test(l) && !/^\s*export \{/.test(l)).join('\n');
      const registers = /\b(registerWorkflow|registerWorkflowDurable|reRegisterWorkflow)\(/.test(body);
      if (!registers) continue;
      const paired = /\brecordRevision\(/.test(body);
      if (!paired && !(rel in ALLOWLIST)) offenders.push(rel);
    }
    expect(offenders, `unpaired workflow write path(s) — append recordRevision or allowlist with a reason:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => {
      try {
        const text = stripComments(readFileSync(join(SRC, rel), 'utf8'));
        const body = text.split('\n').filter((l) => !/^\s*import\b/.test(l)).join('\n');
        return !/\b(registerWorkflow|registerWorkflowDurable|reRegisterWorkflow)\(/.test(body);
      } catch {
        return true; // file gone ⇒ stale
      }
    });
    expect(stale, `allowlist entries no longer registering workflows:\n${stale.join('\n')}`).toEqual([]);
  });
});
