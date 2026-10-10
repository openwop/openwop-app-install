/**
 * ADR 0795 D2 — an `owk_` key reaches a vendor route only through a declared
 * workspace scope.
 *
 * D1 makes every route that ASKS about authority read a key honestly. This is
 * the floor under the routes that do not ask: a safe method needs the key's
 * declaration to permit `workspace:read`, anything else `workspace:write` — the
 * vocabulary the "AI clients (MCP)" tab already mints. Deliberately coarse: it
 * replaces no route's own check.
 *
 * A key that declares nothing (or `*`) is undeclared and passes, as everywhere
 * else (`keyDeclarationPermits`). People and operator env keys are not keys in
 * this sense and are never touched.
 *
 * Some vendor routes own a stricter or finer key gate and are left to it. Every
 * entry is a route whose handler refuses a key itself; the list is short and
 * exact on purpose, because an entry that is too wide exempts a sibling that
 * checks nothing:
 *  - the developer-key routes refuse every key outright (ADR 0800 D1);
 *  - the MCP mount (`POST …/mcp`, that one route) speaks JSON-RPC, so a
 *    read-only client POSTs, and its per-tool gate (`resolveMcpAuthority`) decides;
 *  - the entities API verifies the key against its own `entities:` grammar on
 *    every route (`requireEntitiesScope`, ADR 0386);
 *  - the vendor mirrors of protocol operations gate on PROTOCOL scopes
 *    (`runs:read`, `runs:create`, `approvals:respond`): the review inbox, a
 *    run's interrupt list, the running-conversations index, run re-drive. A
 *    key that declares `runs:read` is meant to reach these — and DECIDING a
 *    review needs `approvals:respond` on both of its arms (`routes/reviews.ts`).
 */
import type { RequestHandler } from 'express';
import { OpenwopError } from '../types.js';
import { keyAuthorityRefuses, keyDeclarationPermits, keyPolicyMode, reportKeyPolicy } from '../host/delegatedSubject.js';
import { ACT_AS_HEADER } from '../host/accessControlService.js';
import { VENDOR_ROOT, isVendorPath } from './protocolVersion.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OWN_GATE_PREFIXES = [
  `${VENDOR_ROOT}/developer-keys`,
  `${VENDOR_ROOT}/entities`,
  `${VENDOR_ROOT}/reviews`,
];
/** The MCP MOUNT only. `/mcp/exposure` and `/mcp/invoke` are ordinary routes. */
const MCP_MOUNT = `${VENDOR_ROOT}/mcp`;
const V = VENDOR_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN_GATE_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: new RegExp(`^${V}/runs/[^/]+/interrupts$`) },
  { method: 'GET', path: new RegExp(`^${V}/chat/sessions/running$`) },
  { method: 'POST', path: new RegExp(`^${V}/runs/redrive$`) },
  // ADR 0799 — `openwop logout`: any key may revoke ITSELF, whatever it declared.
  { method: 'POST', path: new RegExp(`^${V}/cli-login/logout$`) },
];

/** True when the route refuses a key by its own, finer rule. Exported for the test that pins the list. */
export function ownsKeyGate(method: string, rest: string): boolean {
  return (method === 'POST' && rest === MCP_MOUNT)
    || OWN_GATE_PREFIXES.some((p) => rest === p || rest.startsWith(`${p}/`))
    || OWN_GATE_ROUTES.some((r) => r.method === method && r.path.test(rest));
}

function vendorRest(path: string): string | null {
  return isVendorPath(path) ? path : null;
}

export function keyVendorGate(): RequestHandler {
  return (req, _res, next) => {
    const auth = req.principal?.auth;
    if (auth?.kind !== 'api-key') { next(); return; }
    const id = (req.principal?.principalId ?? '').replace(/^apikey:/, '');
    // ADR 0795 D1 — `x-openwop-act-as: <memberId>` makes a route resolve
    // authority for that MEMBER instead of the caller. For a key that is not
    // "view as": it is a way to hold a scope the issuer does not. Refused on
    // every path, before anything reads the header.
    if (req.header(ACT_AS_HEADER) !== undefined && keyAuthorityRefuses('act-as', id, { path: req.path.split('/').slice(0, 5).join('/') })) {
      next(new OpenwopError('forbidden', 'An API key cannot act as another member.', 403, { code: 'key_cannot_act_as' }));
      return;
    }
    const mode = keyPolicyMode('OPENWOP_KEY_VENDOR_GATE');
    if (mode === 'off') { next(); return; }
    const rest = vendorRest(req.path);
    if (rest === null || ownsKeyGate(req.method, rest)) { next(); return; }
    const required = SAFE_METHODS.has(req.method) ? 'workspace:read' : 'workspace:write';
    if (keyDeclarationPermits(auth.scopes, required)) { next(); return; }
    if (mode === 'report') {
      reportKeyPolicy('vendor-gate', id, { family: rest.split('/').slice(0, 4).join('/'), required });
      next();
      return;
    }
    next(new OpenwopError(
      'forbidden_scope',
      `This API key does not declare ${required}, which this part of the API needs. Create a key with the CLI preset, or one that declares it.`,
      403,
      { requiredScope: required, code: 'key_scope_required' },
    ));
  };
}
