/**
 * Shared superadmin gate — extracted from `routes/featureToggles.ts` (ADR
 * 0028: the governance surface needs the SAME admin posture, and a copied
 * gate is an authorization boundary that drifts).
 *
 * A superadmin is: a wildcard bearer principal (`*` — the conformance/admin
 * API key), OR a tenant listed in `OPENWOP_SUPERADMIN_TENANTS`, OR — explicit
 * dev opt-in only, never inferred from NODE_ENV — every authenticated caller
 * when `OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true` (the historical toggle-admin
 * env, kept as the single dev-open switch so a deploy has one knob to audit).
 */

import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.superadmin');

let warnedDevSuperadmin = false;

export function isSuperadmin(req: Request): boolean {
  // Wildcard bearer (conformance harness / admin tooling / curl).
  if (req.principal?.tenants?.includes('*')) return true;
  const allow = (process.env.OPENWOP_SUPERADMIN_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (req.tenantId && allow.includes(req.tenantId)) return true;
  // EXPLICIT dev opt-in only — never inferred from NODE_ENV. Fails closed by
  // default so a misconfigured non-prod deploy isn't world-writable.
  if (process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN === 'true') {
    if (!warnedDevSuperadmin) {
      warnedDevSuperadmin = true;
      log.warn('admin_surface_dev_open', {
        detail: 'OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true — every authenticated caller can administer toggles/governance. Unset it and use OPENWOP_SUPERADMIN_TENANTS for a hardened deploy.',
      });
    }
    return true;
  }
  return false;
}

export function requireSuperadmin(req: Request, surface = 'This administration surface'): void {
  if (!isSuperadmin(req)) {
    throw new OpenwopError('forbidden', `${surface} requires a superadmin principal.`, 403, {
      hint: 'Add your tenant id to OPENWOP_SUPERADMIN_TENANTS, or call with the admin bearer key.',
    });
  }
}
