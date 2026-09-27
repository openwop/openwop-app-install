/**
 * ADR 0601 R1 (corrected) — the MCP tool gate resolves authority for EVERY
 * credential lane `middleware/auth.ts` can mint, deterministically, once per call.
 *
 * The first cut of the ADR 0601 scope gate asked
 * `resolveEffectiveAccess(tenantId, { subject: principal.principalId })`. That
 * question has no answer for a credential principal: only the cookie/OIDC lanes
 * mint a `principalId` that is ALSO the RBAC subject a member row is keyed on.
 * MEASURED on that revision with demo mode OFF, by reverting the scope block:
 * **17 gated tools → 0**, for the env-key lane, the `owk_` key lane, the
 * anonymous-session lane AND the conformance seam. Four lanes, and every one of
 * them green in demo mode (`accessControlService.ts:1271` grants an unknown
 * subject OWNER when `demoMode() && isSinglePrincipalTenant`), which is why the
 * regression could ship: the demo deploy is the one place it does not bite.
 *
 * This file is the lane TABLE. It enumerates the principal shapes by call graph
 * from `middleware/auth.ts` (not by the ones a reader happened to name) and pins
 * the verdict for each, so a future change to identity resolution cannot take a
 * lane dark while the rest of the suite stays green.
 *
 * The three properties it defends, each of which a plausible "fix" gets wrong:
 *
 *  - RESTORATION without ESCALATION. An `owk_` key is a delegation of its
 *    ISSUER's authority. Granting an unscoped key the tenant's own authority
 *    instead — the tempting reading of "a key carries its own authority" — would
 *    let any `viewer` mint themselves a key (`POST /developer-keys` is gated on
 *    `requirePrincipal` alone) and write over MCP, re-opening NBC-3 sideways.
 *    `viewerKey` below is that case.
 *  - DETERMINISM. `resolveEffectiveAccess` with no `orgId` takes the FIRST
 *    matching member row, so a subject who is `viewer` in org-A and `editor` in
 *    org-B resolved to whichever the store iterated first. `multiOrg` pins the
 *    union.
 *  - The DEMO EXCEPTION survives. Swapping to `resolveSubjectScopesUnion` alone
 *    (the obvious determinism fix) drops the single-principal/demo grant, which
 *    lives only in `resolveEffectiveAccess`. MEASURED by doing exactly that:
 *    the anonymous-session lane went 17 → 0 with demo mode ON. `demo mode`
 *    below is that witness.
 *
 * @see docs/adr/0601-notebooks-trust-boundary-and-mcp-authz.md § Corrections
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Counters for the MEDIUM-5 fan-out assertion. `vi.hoisted` because the mock
 *  factory below is hoisted above every import. */
const calls = vi.hoisted(() => ({ union: 0, effective: 0 }));

vi.mock('../src/host/accessControlService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/accessControlService.js')>();
  return {
    ...actual,
    resolveSubjectScopesUnion: (...args: Parameters<typeof actual.resolveSubjectScopesUnion>) => {
      calls.union++;
      return actual.resolveSubjectScopesUnion(...args);
    },
    resolveEffectiveAccess: (...args: Parameters<typeof actual.resolveEffectiveAccess>) => {
      calls.effective++;
      return actual.resolveEffectiveAccess(...args);
    },
  };
});

import { createApp } from '../src/index.js';
import { isToolAllowed, listToolsForPrincipal, listTools } from '../src/host/mcpServerRegistry.js';
import { createCustomRole, createMember } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Principal } from '../src/types.js';

const T = 'tenant-authority-lanes';
const WRITE_TOOL = 'notebook-add-source';
const READ_TOOL = 'notebook-search';

const p = (principalId: string, auth?: Principal['auth'], tenant = T): Principal =>
  ({ principalId, tenants: [tenant], token: '', ...(auth ? { auth } : {}) });

/** The lanes, by call graph from `middleware/auth.ts`. */
const LANES = {
  /** auth.ts — `OPENWOP_API_KEYS` entry scoped to one tenant (ADR 0561). */
  envKey: p('bearer:abcd1234', { kind: 'env-key' }),
  /** auth.ts — a `<key>:*` operator key. Denied by `isAnonymousPrincipal`
   *  (pre-existing ADR 0087 posture, deliberately not widened by ADR 0601). */
  envKeyWildcard: p('bearer:abcd1234', { kind: 'env-key' }, '*'),
  /** auth.ts — an ADR 0270 `owk_` key minted by an OWNER, no declared scopes. */
  ownerKey: p('apikey:dk:owner', { kind: 'api-key', issuer: 'subject-owner', scopes: [] }),
  /** auth.ts — the SAME key shape minted by a VIEWER. The escalation case. */
  viewerKey: p('apikey:dk:viewer', { kind: 'api-key', issuer: 'subject-viewer', scopes: [] }),
  /** auth.ts — an owner's key that DECLARES `workspace:read` (ADR 0270: a key
   *  can't exceed its scopes — here it is narrower than its issuer). */
  narrowedKey: p('apikey:dk:narrow', { kind: 'api-key', issuer: 'subject-owner', scopes: ['workspace:read'] }),
  /** auth.ts — a cookie session bound to a durable user / an OIDC bearer. */
  ownerSubject: p('subject-owner', { kind: 'subject' }),
  viewerSubject: p('subject-viewer', { kind: 'subject' }),
  /** auth.ts — read in org-A, write in org-B, via two DISJOINT custom roles.
   *  The determinism case (see the seeding note in `beforeAll`). */
  multiOrg: p('subject-multi', { kind: 'subject' }),
  /** auth.ts — an anonymous cookie session in its own `anon:<sid>` tenant. */
  anonSession: p('session:sid-lanes', { kind: 'anon' }, 'anon:sid-lanes'),
  /** routes/mcp.ts — the `OPENWOP_TEST_SEAM_ENABLED` conformance principal. */
  testSeam: p('mcp-test-seam', { kind: 'test-seam' }, 'default'),
  /** A principal minted outside the auth boundary: no provenance ⇒ fail closed. */
  unstamped: p('subject-unknown'),
} as const;

const tool = (name: string) => {
  const t = listTools().find((x) => x.name === name);
  expect(t, `tool ${name} is not registered — every assertion below would be vacuous`).toBeTruthy();
  return t!;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // MUST be off: the demo single-principal exception grants OWNER to an unknown
  // subject, which would make every fail-closed case below pass vacuously. The
  // one test that WANTS it sets it explicitly and restores it.
  delete process.env.OPENWOP_DEMO_MODE;
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await createMember({ tenantId: T, orgId: 'org-a', subject: 'subject-owner', displayName: 'O', roles: ['owner'] });
  await createMember({ tenantId: T, orgId: 'org-a', subject: 'subject-viewer', displayName: 'V', roles: ['viewer'] });
  // The non-determinism case: two member rows, two DISJOINT authorities, no
  // orgId at the gate.
  //
  // The roles must be disjoint, and this is the part a first draft got wrong.
  // Seeding `viewer` in org-A and `editor` in org-B looks like the case the
  // finding describes, but `editor`'s scopes are a strict SUPERSET of
  // `viewer`'s: a first-match resolver that lands on `editor` gives the union's
  // answer by accident. MEASURED — sabotaging the resolver back to first-match
  // left that draft GREEN through the whole file, because which row the store
  // returns first is exactly the thing under test and cannot be relied on to
  // make the assertion bite. So org-A grants ONLY `workspace:read` and org-B
  // ONLY `workspace:write`. Neither row alone satisfies both assertions below,
  // so a first-match resolver fails one of them WHICHEVER row it picks.
  const readOnly = await createCustomRole({ tenantId: T, orgId: 'org-a', name: 'read-only-a', scopes: ['workspace:read'] });
  const writeOnly = await createCustomRole({ tenantId: T, orgId: 'org-b', name: 'write-only-b', scopes: ['workspace:write'] });
  await createMember({ tenantId: T, orgId: 'org-a', subject: 'subject-multi', displayName: 'M', roles: [readOnly.roleId] });
  await createMember({ tenantId: T, orgId: 'org-b', subject: 'subject-multi', displayName: 'M', roles: [writeOnly.roleId] });
});

afterAll(() => { delete process.env.OPENWOP_DEMO_MODE; });

describe('ADR 0601 R1 — every credential lane resolves to an authority', () => {
  it('the API-key lanes SEE gated tools again (the regression this corrects)', async () => {
    // Not "more than zero": a floor of zero is what the defect looked like, so
    // pin the shape — an env key and an owner-issued key hold WRITE, which is
    // the strongest claim either lane can make.
    for (const lane of ['envKey', 'ownerKey'] as const) {
      expect(await isToolAllowed(tool(READ_TOOL), LANES[lane]), `${lane} read`).toBe(true);
      expect(await isToolAllowed(tool(WRITE_TOOL), LANES[lane]), `${lane} write`).toBe(true);
    }
    // …and they see the whole gated catalog, not a lucky one.
    const gated = listTools().filter((t) => Boolean(t.mcpRequiresAuth || t.mcpFeatureToggle));
    expect(gated.length).toBeGreaterThan(0);
    const visible = await listToolsForPrincipal(LANES.envKey);
    for (const t of gated.filter((g) => g.name.startsWith('notebook-'))) {
      expect(visible.map((v) => v.name), t.name).toContain(t.name);
    }
  });

  it('ESCALATION GUARD — a key minted BY A VIEWER carries the viewer’s authority, not the tenant’s', async () => {
    // `POST /developer-keys` is gated on `requirePrincipal` alone, so a viewer
    // can mint this key. If a key were granted authority of its own, this is the
    // line that would go green and NBC-3 would be re-opened through a side door.
    expect(await isToolAllowed(tool(READ_TOOL), LANES.viewerKey)).toBe(true);
    expect(await isToolAllowed(tool(WRITE_TOOL), LANES.viewerKey)).toBe(false);
    // And the subject it delegates from is denied the same tool directly, so the
    // key is provably not widening anything.
    expect(await isToolAllowed(tool(WRITE_TOOL), LANES.viewerSubject)).toBe(false);
  });

  it('a key that DECLARES scopes is narrowed to them, even when its issuer is an owner', async () => {
    expect(await isToolAllowed(tool(WRITE_TOOL), LANES.ownerKey), 'issuer holds write').toBe(true);
    expect(await isToolAllowed(tool(READ_TOOL), LANES.narrowedKey)).toBe(true);
    expect(await isToolAllowed(tool(WRITE_TOOL), LANES.narrowedKey)).toBe(false);
  });

  it('DETERMINISM — a subject with read in org-A and write in org-B holds BOTH (the union), whichever row the store returns first', async () => {
    // The gate names no org, so the only defensible answer is "in ANY org".
    // Both assertions together are the witness: a first-match resolver can
    // satisfy either one, never both, so it fails regardless of iteration order.
    expect(await isToolAllowed(tool(READ_TOOL), LANES.multiOrg), 'read, granted only by org-A').toBe(true);
    expect(await isToolAllowed(tool(WRITE_TOOL), LANES.multiOrg), 'write, granted only by org-B').toBe(true);
    // …and stably, call over call.
    for (let i = 0; i < 5; i++) {
      expect(await isToolAllowed(tool(WRITE_TOOL), LANES.multiOrg), `pass ${i}`).toBe(true);
      expect(await isToolAllowed(tool(READ_TOOL), LANES.multiOrg), `pass ${i}`).toBe(true);
    }
  });

  it('FAIL CLOSED — a member of nothing, an anonymous session, the seam, and an unstamped principal all get nothing', async () => {
    for (const lane of ['anonSession', 'testSeam', 'unstamped', 'envKeyWildcard'] as const) {
      expect(await isToolAllowed(tool(READ_TOOL), LANES[lane]), `${lane} read`).toBe(false);
      expect(await isToolAllowed(tool(WRITE_TOOL), LANES[lane]), `${lane} write`).toBe(false);
    }
  });

  it('the DEMO single-principal exception is preserved (the union-only fix loses it)', async () => {
    // `accessControlService.ts:1271` grants an unknown subject OWNER in a
    // single-principal tenant under demo mode. It lives in ONE place and the MCP
    // gate reaches it rather than copying it. MEASURED: replacing the fallback
    // with `resolveSubjectScopesUnion` alone takes this lane 17 tools → 0, which
    // is every anonymous visitor on the demo deploy.
    process.env.OPENWOP_DEMO_MODE = 'true';
    try {
      expect(await isToolAllowed(tool(READ_TOOL), LANES.anonSession)).toBe(true);
      expect(await isToolAllowed(tool(WRITE_TOOL), LANES.anonSession)).toBe(true);
    } finally {
      delete process.env.OPENWOP_DEMO_MODE;
    }
    // …and it is genuinely conditional on the flag, not always-on.
    expect(await isToolAllowed(tool(READ_TOOL), LANES.anonSession)).toBe(false);
  });

  it('FAN-OUT — one tools/list resolves authority ONCE, not once per tool', async () => {
    const gated = listTools().filter((t) => Boolean(t.mcpRequiresAuth || t.mcpFeatureToggle));
    // A floor, so an empty registry cannot make the ceiling below trivially true.
    expect(gated.length, 'gated tool population').toBeGreaterThanOrEqual(10);
    calls.union = 0;
    calls.effective = 0;
    await listToolsForPrincipal(LANES.ownerSubject);
    // `resolveEffectiveAccess` full-scans members + groups + customRoles, and
    // `members.list()` is the CROSS-TENANT scan the tenant index exists to
    // avoid: per-tool resolution meant ~3 × 19 collection scans on one call.
    expect(calls.union + calls.effective, 'access resolutions per tools/list').toBe(1);
  });

  it('FAN-OUT — a single-tool gate resolves authority at most twice (union + no-membership fallback)', async () => {
    calls.union = 0;
    calls.effective = 0;
    await isToolAllowed(tool(WRITE_TOOL), LANES.unstamped);
    expect(calls.union + calls.effective).toBeLessThanOrEqual(2);
  });
});
