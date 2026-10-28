/**
 * ADR 0887 D1 step 1 — the visitor-lane exemption is decided by the `system:`
 * actor prefix. A share link minted with any OTHER actor is re-checked against
 * that actor as its publisher on every read, so a host-side mint that forgot the
 * prefix would mint links that are dark on arrival — and one that used a person's
 * id for a visitor's receipt would tie the buyer's receipt to that person's job.
 *
 * Pins every `createLink(` call site in `src/`: the one member route passes the
 * signed-in user; every other site passes a `'system:<feature>'` literal (directly
 * or through a same-file const). A new call site fails here until it is reviewed.
 *
 * Tracker TST-BHF-4. Red when (sabotage-witnessed, wave 62): a host-side mint drops
 * its `system:` actor (e.g. the CRM sign link).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('ADR 0887 — every share-link mint names its lane', () => {
  it('only the member route mints as a person; every other site mints as system:*', () => {
    const sites: Record<string, string[]> = {};
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      // `(?<!function )` — the definition's own parameter list is not a call site.
      for (const m of src.matchAll(/(?<!function )\bcreateLink\(\s*[^,]+,\s*[^,]+,\s*([^,]+),/g)) {
        const actor = m[1]!.trim();
        const literal = /^'([^']*)'$/.exec(actor)?.[1]
          ?? new RegExp(`const\\s+${actor.replace(/[.$]/g, '\\$&')}\\s*=\\s*'([^']*)'`).exec(src)?.[1];
        (sites[relative(SRC, f)] ??= []).push(literal ?? actor);
      }
    }
    expect(sites).toEqual({
      'features/sharing/routes.ts': ['user.userId'],
      'features/commerce/commerceService.ts': ['system:commerce'],
      'features/crm/bookingService.ts': ['system:crm-booking'],
      'features/crm/signService.ts': ['system:crm-sign'],
      // ADR 0924 D5 — the client approver link, minted on the visitor lane.
      'features/campaign-ops/portal.ts': ['system:campaign-ops-portal'],
      // ADR 0958 D2 — the collaborator invite. System-minted on purpose: accepting
      // binds an identity and grants nothing. Every grant is minted separately by a
      // member and re-checks that member on each use (`checkGrantUse` granter check).
      'features/campaign-ops/collaboration/routes.ts': ['system:campaign-ops-collab'],
    });
  });
});
