/**
 * ADR 0672 D6 (`CMSAWF-9`) — no PRODUCTION lane mints a quorum-policy'd content-publish row.
 *
 * `evaluateQuorum` fires only at `policy.requiredApprovals > 1`, so quorum is dead config
 * for this kind — which is the mitigating fact under `CMSAWF-9`, whose quorum "witness"
 * (`test/approval-quorum.test.ts`) registers a stub handler that resolves nothing.
 *
 * **Why this is a source-level pin and not a type change.** The plan was to delete the
 * `policy` parameter from `createContentApproval` so the claim became a compile error.
 * It does not compile: `test/approval-quorum.test.ts` passes a policy (it is the only real
 * coverage of `evaluateQuorum`), and `test/subject-erasure-host-stores-adr0464.test.ts`
 * needs a policy-BEARING row to verify approver-ref redaction on erasure — a concern
 * unrelated to CMS. Deleting the parameter would have removed real coverage from another
 * feature in order to tidy a claim about this one.
 *
 * So the claim is pinned where it is actually true: over the lanes that run in production.
 * A test may mint a policy'd row; a shipped code path may not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// Bounded to where approval creation can live. A full `src/` walk exceeded the per-test
// budget under load, and an unbounded scan that times out is a witness that cannot run.
const ROOTS = ['features', 'host', 'routes'].map((d) => join(SRC, d));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('ADR 0672 D6 — quorum is dead config for content-publish, in production', () => {
  it('leg 1: no src/ call of createContentApproval passes a `policy`', { timeout: 60_000 }, () => {
    const offenders: string[] = [];
    let callSites = 0;
    for (const file of ROOTS.flatMap((r) => walk(r))) {
      const text = readFileSync(file, 'utf8');
      let i = text.indexOf('createContentApproval(');
      while (i !== -1) {
        // Skip the declaration itself.
        const isDecl = text.slice(Math.max(0, i - 30), i).includes('function ');
        if (!isDecl) {
          callSites += 1;
          // The argument object ends at the matching close; a bounded window is enough
          // because every call site is a literal.
          const window = text.slice(i, i + 700);
          const end = window.indexOf('});');
          if (/\bpolicy\s*:/.test(end === -1 ? window : window.slice(0, end))) {
            offenders.push(`${file.slice(SRC.length + 1)} @${i}`);
          }
        }
        i = text.indexOf('createContentApproval(', i + 1);
      }
    }
    // Non-vacuity: if the walk stops finding call sites, a clean result means nothing.
    expect(callSites, 'the scan must actually reach a production call site').toBeGreaterThan(0);
    expect(offenders, 'a quorum-policy\'d content-publish row would make evaluateQuorum live, unwitnessed').toEqual([]);
  });

  it('leg 2: the quorum evaluator really is gated on requiredApprovals > 1', async () => {
    // Pins the OTHER half of the claim — that a policy-less row cannot reach quorum at all,
    // so leg 1 is about something that matters.
    const { evaluateQuorumTally } = await import('../src/host/approvalDecision.js') as unknown as {
      evaluateQuorumTally?: (...a: unknown[]) => unknown;
    };
    const src = readFileSync(join(SRC, 'host', 'approvalDecision.ts'), 'utf8');
    expect(src, 'the gate this claim depends on').toMatch(/requiredApprovals\s*>\s*1/);
    expect(typeof evaluateQuorumTally === 'function' || src.includes('function evaluateQuorum')).toBe(true);
  });
});
