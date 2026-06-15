/**
 * CSM feature routes (host-extension, best-effort — ADR 0001 §6 Phase 6).
 *
 * Surface under /v1/host/openwop-app/csm. Toggle-gated on `csm` (backend authority —
 * 404 when off). A plain on/off feature (no variants) — demonstrating the
 * contract works for the non-multivariant case too.
 *
 *   GET    /accounts            list the caller's accounts (lowest health first)
 *   POST   /accounts            create an account
 *   PATCH  /accounts/:id        update name / healthScore
 *   DELETE /accounts/:id        remove
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from './accountsService.js';

const TOGGLE_ID = 'csm';

function subjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: req.tenantId ?? 'default' };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  return subject;
}

async function requireEnabled(req: Request): Promise<void> {
  const assignment = await resolveOne(TOGGLE_ID, subjectOf(req));
  if (!assignment || !assignment.enabled) {
    throw new OpenwopError('not_found', 'CSM is not enabled for this tenant.', 404, { feature: TOGGLE_ID });
  }
}

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

function parseScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OpenwopError('validation_error', 'Field `healthScore` MUST be a number in [0, 100].', 400, { field: 'healthScore' });
  }
  return value;
}

export function registerCsmRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/v1/host/openwop-app/csm/accounts', async (req, res, next) => {
    try {
      await requireEnabled(req);
      res.json({ accounts: await listAccounts(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/csm/accounts', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as { name?: unknown; healthScore?: unknown };
      const account = await createAccount({
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        ...(parseScore(body.healthScore) !== undefined ? { healthScore: parseScore(body.healthScore) } : {}),
      });
      res.status(201).json(account);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/openwop-app/csm/accounts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const existing = await getAccount(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Account not found.', 404, { accountId: req.params.id });
      }
      const body = (req.body ?? {}) as { name?: unknown; healthScore?: unknown };
      const updated = await updateAccount(req.params.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(parseScore(body.healthScore) !== undefined ? { healthScore: parseScore(body.healthScore) } : {}),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/csm/accounts/:id', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const existing = await getAccount(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Account not found.', 404, { accountId: req.params.id });
      }
      await deleteAccount(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
