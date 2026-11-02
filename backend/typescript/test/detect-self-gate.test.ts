/**
 * ADR 0419 · GATE-4 — the AST self-gate detector, adversarially.
 *
 * The prior source-text heuristic documented three false-negatives it could not
 * see. These cases prove the AST detector (`helpers/detectSelfGate.ts`) catches all
 * three, AND that it still exempts the legitimate resource-derived public-route case
 * (over-detecting would 403 anonymous visitors — a worse bug than the one closed).
 *
 * TST-CVD-10. Double coverage: `bundle-gating-invariant.test.ts` runs this same
 * detector over the real feature sources (crm/csm must be detected through
 * `resolveToggle`, cdp/destination-sync must be clean). Red when: the one-hop
 * const binding is not followed (R1), the import alias is not tracked (R2), a
 * const or `FEATURE.toggleId` toggle id is not resolved, another feature's toggle
 * counts as a self-gate, or the `org.tenantId` resource exemption is dropped —
 * the MIXED subject below carries both `org.tenantId` and `req`, so only that
 * exemption keeps it clean (a subject with no `req` at all is clean either way).
 */
import { describe, it, expect } from 'vitest';
import { detectRequestSubjectSelfGate } from './helpers/detectSelfGate.js';

const detect = (src: string, id = 'foo') => detectRequestSubjectSelfGate(src, id, 'foo/routes.ts');
const IMPORT = "import { resolveOne } from '../../host/featureToggles/service.js';\n";

describe('detectRequestSubjectSelfGate — closes the regex residuals', () => {
  it('R1: subject BOUND TO A VARIABLE first (regex missed — arg is a bare identifier)', () => {
    const src = IMPORT + `async function g(req: any) {
      const s = subjectOf(req);
      const a = await resolveOne('foo', s);
    }`;
    expect(detect(src)).not.toBeNull();
  });

  it('R2: ALIASED resolveOne import (regex missed — the call reads r(...))', () => {
    const src = "import { resolveOne as r } from '../../host/featureToggles/service.js';\n"
      + `async function g(req: any) { await r('foo', subjectOf(req)); }`;
    expect(detect(src)).not.toBeNull();
  });

  it('R3: a WIDE gap between the two arguments (regex window was 120 chars)', () => {
    const filler = ' '.repeat(300);
    const src = IMPORT + `async function g(req: any) { await resolveOne('foo',${filler}subjectOf(req)); }`;
    expect(detect(src)).not.toBeNull();
  });

  it('resolves an aliased TOGGLE constant (const hop) as the own toggle', () => {
    const src = IMPORT + `const TOGGLE_ID = 'foo';
    async function g(req: any) { await resolveOne(TOGGLE_ID, subjectOf(req)); }`;
    expect(detect(src)).not.toBeNull();
  });

  it('resolves a FEATURE.toggleId object member as the own toggle', () => {
    const src = IMPORT + `const FEATURE = { toggleId: 'foo', label: 'Foo' };
    async function g(req: any) { await resolveOne(FEATURE.toggleId, subjectOf(req)); }`;
    expect(detect(src)).not.toBeNull();
  });

  describe('does NOT over-detect', () => {
    it('a RESOURCE-derived subject stays exempt (ADR 0176 public route)', () => {
      const src = IMPORT + `async function g(orgId: string) {
        const org = await getOrg(orgId);
        await resolveOne('foo', { tenantId: org.tenantId });
      }`;
      expect(detect(src)).toBeNull();
      // MIXED subject: the tenant comes from the resource, the request only
      // supplies an actor. The org.tenantId exemption is what keeps it clean.
      const mixed = IMPORT + `async function g(req: Request) {
        const org = await getOrg(req.params.orgId);
        await resolveOne('foo', { tenantId: org.tenantId, userId: req.userId });
      }`;
      expect(detect(mixed)).toBeNull();
      // …and the same request-only subject without the resource tenant IS a hit,
      // so the mixed case above is reaching the exemption, not missing the call.
      const requestOnly = IMPORT + `async function g(req: Request) {
        await resolveOne('foo', { tenantId: req.tenantId, userId: req.userId });
      }`;
      expect(detect(requestOnly)).not.toBeNull();
    });

    it('a resource-derived subject BOUND to a variable stays exempt too', () => {
      const src = IMPORT + `async function g(org: any) {
        const subj = { tenantId: org.tenantId };
        await resolveOne('foo', subj);
      }`;
      expect(detect(src)).toBeNull();
    });

    it("ANOTHER feature's toggle with a request subject is not a self-gate", () => {
      const src = IMPORT + `async function g(req: any) { await resolveOne('production', subjectOf(req)); }`;
      expect(detect(src)).toBeNull();
    });

    it('a file that never calls resolveOne is clean', () => {
      expect(detect("export const x = 1;")).toBeNull();
    });
  });
});
