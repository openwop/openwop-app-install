import { describe, it, expect } from 'vitest';

import { resolveCanvasOrg } from '../resolveCanvasOrg.js';

const A = { orgId: 'org-a', name: 'Alpha' };
const B = { orgId: 'org-b', name: 'Beta' };

describe('resolveCanvasOrg', () => {
  // THE BUG. `orgs[0]` would answer 'org-a' and the canvas — which lives in
  // org-b — comes back as a generic load error the user cannot act on.
  it('uses the org named on the link, not the first one', () => {
    expect(resolveCanvasOrg([A, B], 'org-b')).toEqual({ kind: 'ok', orgId: 'org-b' });
  });

  it('refuses an org the caller does not belong to instead of falling back', () => {
    expect(resolveCanvasOrg([A, B], 'org-zzz')).toEqual({ kind: 'notMember', requested: 'org-zzz' });
  });

  // Not a guess: with one org there is nothing else it could be.
  it('uses the only org when none was named', () => {
    expect(resolveCanvasOrg([A], null)).toEqual({ kind: 'ok', orgId: 'org-a' });
  });

  // The honest case — this is what `orgs[0]` was hiding.
  it('reports ambiguous rather than guessing when several orgs and no link org', () => {
    expect(resolveCanvasOrg([A, B], null)).toEqual({ kind: 'ambiguous', orgs: [A, B] });
    expect(resolveCanvasOrg([A, B], '')).toEqual({ kind: 'ambiguous', orgs: [A, B] });
    expect(resolveCanvasOrg([A, B], '   ')).toEqual({ kind: 'ambiguous', orgs: [A, B] });
  });

  it('reports none when the caller has no orgs', () => {
    expect(resolveCanvasOrg([], null)).toEqual({ kind: 'none' });
    expect(resolveCanvasOrg([], 'org-a')).toEqual({ kind: 'none' });
  });

  // A single org that is NOT the one asked for is still a refusal — being a
  // member of exactly one org must not launder a wrong link into a silent open.
  it('does not launder a wrong org just because the caller has only one', () => {
    expect(resolveCanvasOrg([A], 'org-b')).toEqual({ kind: 'notMember', requested: 'org-b' });
  });
});
