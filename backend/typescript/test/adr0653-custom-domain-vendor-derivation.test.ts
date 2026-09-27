/**
 * ADR 0653 phase B — custom-domain routing derives its vendor prefix instead of
 * hardcoding it.
 *
 * RFC 0181 makes `/host/openwop-app/…` the canonical vendor root; the `/v1/…`
 * form is a TWIN that "retires atomically with `/v1`" (`versioning.md` §5), and
 * the December flip INVERTS the rewrite. A literal in `customDomain.ts` would
 * therefore survive the flip pointing at a path that no longer resolves — and
 * custom domains are live traffic, so the failure would be an adopter's site
 * going dark rather than a test going red.
 *
 * The peer session (`kicktodo-1`) found this dependency before the refactor
 * started, which is the only reason it is a test rather than an incident.
 *
 * Pinned on the SOURCE, not on behaviour, and the distinction is the point: a
 * behavioural test passes identically whether the path was derived or spelled
 * out, because through the overlap both forms resolve. Only the source can say
 * which one this file will still be correct after.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vendorTwin } from '../src/middleware/protocolVersion.js';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'middleware', 'customDomain.ts'),
  'utf8',
);

describe('ADR 0653 pB — the vendor prefix is derived, not written', () => {
  it('customDomain.ts contains NO versioned vendor-path literal', () => {
    // Built at runtime so this test does not itself become the literal it bans —
    // the same reason the file's own comment declines to spell it out.
    const versionedVendorLiteral = `${'/v1'}/host/openwop-app/`;
    expect(SRC).not.toContain(versionedVendorLiteral);
  });

  it('and it routes through vendorTwin', () => {
    expect(SRC).toContain('vendorTwin');
    expect(SRC).toMatch(/import \{ vendorTwin \} from '\.\/protocolVersion\.js'/);
  });

  it('vendorTwin still produces the twin the rewrite depends on', () => {
    // If this ever stops holding, the derivation is correct and the CONSTANT
    // moved — which is exactly the migration this indirection exists to absorb.
    // Asserting the shape rather than the string keeps the test honest through
    // the flip: it pins that a twin is produced, not that it is spelled `/v1`.
    const twin = vendorTwin('/public');
    expect(twin.endsWith('/host/openwop-app/public')).toBe(true);
    expect(twin.startsWith('/')).toBe(true);
  });

  it('the org-pinned base is built from the same helper as the prefix list', () => {
    // One owner. If the prefix list and the rewrite base ever derive
    // differently, a request could pass the prefix check and rewrite to an
    // address the check never validated — the org-equality invariant the
    // docblock says "holds by construction" would quietly stop holding.
    const usages = SRC.match(/vendorTwin\('\/public'\)/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(2);
  });
});
