/**
 * ADR 0742 — runtime posture routes (superadmin only, host-extension).
 *
 *   GET  /v1/host/openwop-app/runtime-posture                  → live posture read back from Cloud Run
 *   POST /v1/host/openwop-app/runtime-posture/change-requests  → { warm: boolean } ONLY → audited
 *        change request carrying the exact commands. Nothing is applied: the
 *        host holds no write credential on its own service (see service.ts).
 *
 * Non-normative host-extension namespace — no wire, no RFC. Gated by
 * `requireSuperadmin` like heartbeat / appearance / navigation settings.
 */
import { createLogger } from '../../observability/logger.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { readLivePosture } from './liveRead.js';
import { ChangeRequestInvalidError, changeCommands, validateChangeRequest } from './service.js';

const log = createLogger('features.runtimePosture');
const BASE = '/v1/host/openwop-app/runtime-posture';

export function registerRuntimePostureRoutes(deps: RouteDeps, read: typeof readLivePosture = readLivePosture): void {
  const { app, storage } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      res.json(await read());
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/change-requests`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      let wanted: { warm: boolean };
      try {
        wanted = validateChangeRequest(req.body);
      } catch (err) {
        if (err instanceof ChangeRequestInvalidError) {
          res.status(400).json({ error: 'validation_error', message: err.message });
          return;
        }
        throw err;
      }
      const live = await read();
      if (!live.available) {
        res.status(409).json({ error: 'posture_unreadable', message: `the live posture cannot be read, so no change request is issued: ${live.reason}` });
        return;
      }
      const to = wanted.warm ? 'warm' : 'cold';
      const from = live.serving?.posture ?? 'unknown';
      const principalId = req.userId ?? req.principal?.principalId ?? req.tenantId ?? 'unknown';
      const commands = changeCommands(wanted.warm, live);
      await storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: String(principalId),
        action: 'runtime_posture.change_requested',
        resource: `${live.project}/${live.region}/${live.service}`,
        outcome: 'success',
        payload: { from, to, servingRevision: live.servingRevision, pendingRevision: live.pendingRevision },
      });
      log.info('runtime_posture_change_requested', { from, to, servingRevision: live.servingRevision });
      res.status(201).json({
        from,
        to,
        servingRevision: live.servingRevision,
        noop: from === to && live.rollout === 'settled',
        commands,
        note: 'Nothing has been applied. Run the commands with an account holding run.services.update; the change is live only when this page shows the new revision serving 100 %.',
      });
    } catch (err) {
      next(err);
    }
  });
}
