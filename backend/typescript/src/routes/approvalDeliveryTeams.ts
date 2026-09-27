/**
 * Teams approval-delivery preference routes (ADR 0198 Phase B) — host
 * extension, non-normative. Strictly self-service: a signed-in user manages
 * where THEIR OWN approval requests are delivered. The card send itself uses
 * the caller's microsoft365 connection via the broker (fail-closed without
 * one — ADR 0033 deploy-gating).
 *
 *   GET    /v1/host/openwop-app/approval-delivery/teams   — my pref (or null)
 *   PUT    /v1/host/openwop-app/approval-delivery/teams   — { connectionId, chatId }
 *   DELETE /v1/host/openwop-app/approval-delivery/teams
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import {
  getTeamsDeliveryPref,
  setTeamsDeliveryPref,
  clearTeamsDeliveryPref,
} from '../host/teamsApprovalDelivery.js';

const PATH = '/v1/host/openwop-app/approval-delivery/teams';

function callerUserId(req: Request): string {
  const userId = req.userId;
  if (!userId) {
    throw new OpenwopError('forbidden', 'Managing approval delivery requires a signed-in user.', 403, {});
  }
  return userId;
}

export function registerApprovalDeliveryTeamsRoutes(app: Express): void {
  app.get(PATH, async (req, res, next) => {
    try {
      const pref = await getTeamsDeliveryPref(tenantOf(req), callerUserId(req));
      res.json({ pref });
    } catch (err) {
      next(err);
    }
  });

  app.put(PATH, async (req, res, next) => {
    try {
      const userId = callerUserId(req);
      const body = (req.body ?? {}) as { connectionId?: unknown; chatId?: unknown };
      const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!connectionId || !chatId) {
        throw new OpenwopError('validation_error', 'connectionId and chatId are required.', 400, {});
      }
      const pref = await setTeamsDeliveryPref({ tenantId: tenantOf(req), userId, connectionId, chatId });
      res.json({ pref });
    } catch (err) {
      next(err);
    }
  });

  app.delete(PATH, async (req, res, next) => {
    try {
      const removed = await clearTeamsDeliveryPref(tenantOf(req), callerUserId(req));
      res.json({ removed });
    } catch (err) {
      next(err);
    }
  });
}
