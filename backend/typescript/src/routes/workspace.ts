/**
 * RFC 0059 — agent workspace file endpoints (§C) + the cross-owner test seam.
 *
 * Wire endpoints (owner = the authenticated `{tenant, workspace}`; this demo
 * has a single workspace per tenant, `'default'`):
 *   GET    /v1/host/workspace/files            → { files: WorkspaceFileMeta[] }
 *   GET    /v1/host/workspace/files/:path      → WorkspaceFile | 404
 *   PUT    /v1/host/workspace/files/:path      → WorkspaceFile | 409 | 413
 *   DELETE /v1/host/workspace/files/:path      → 204 | 404
 *
 * Owner identity comes from `req.tenantId` (the authenticated principal),
 * NEVER the body/query — the WCT-1 fail-closed contract. Cross-owner access
 * (a different `{tenant, workspace}`) simply finds nothing → 404, no leak.
 *
 * The `POST /v1/host/openwop-app/workspace/op` seam lets a single-credential
 * conformance harness drive DISTINCT owners (its `{tenant, workspace}` come
 * from the body) so it can prove cross-owner isolation (WCT-1).
 *
 * @see RFCS/0059-agent-workspace.md §C/§E
 * @see SECURITY/invariants.yaml workspace-cross-tenant-isolation
 */

import type { Express, Request, Response } from 'express';
import {
  putWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  deleteWorkspaceFile,
} from '../host/workspaceStore.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.workspace');

/** This demo binds one workspace per tenant. */
const DEFAULT_WORKSPACE = 'default';

function ownerOf(req: Request): { tenant: string; workspace: string } {
  return { tenant: req.tenantId ?? 'default', workspace: DEFAULT_WORKSPACE };
}

function ifMatch(req: Request): string | undefined {
  const h = req.get('If-Match');
  return typeof h === 'string' && h.length > 0 ? h : undefined;
}

/** Apply one workspace op against an explicit owner. Shared by the wire
 *  endpoints (owner from auth) and the cross-owner seam (owner from body). */
async function applyOp(
  storage: Storage,
  res: Response,
  owner: { tenant: string; workspace: string },
  op: { kind: 'list'; prefix?: string }
    | { kind: 'get'; path: string }
    | { kind: 'put'; path: string; content: string; contentType?: string; ifMatch?: string }
    | { kind: 'delete'; path: string },
): Promise<void> {
  const { tenant, workspace } = owner;
  switch (op.kind) {
    case 'list':
      res.status(200).json({ files: await listWorkspaceFiles(storage, tenant, workspace, op.prefix) });
      return;
    case 'get': {
      const file = await getWorkspaceFile(storage, tenant, workspace, op.path);
      if (!file) {
        sendError(res, 404, 'not_found', 'No such workspace file.');
        return;
      }
      res.status(200).json(file);
      return;
    }
    case 'put': {
      const outcome = await putWorkspaceFile(storage, tenant, workspace, op.path, {
        content: op.content,
        ...(op.contentType !== undefined ? { contentType: op.contentType } : {}),
        ...(op.ifMatch !== undefined ? { ifMatch: op.ifMatch } : {}),
      });
      if (!outcome.ok) {
        sendError(res, outcome.status, outcome.error, outcome.message, outcome.details);
        return;
      }
      res.status(200).json(outcome.file);
      return;
    }
    case 'delete': {
      const existed = await deleteWorkspaceFile(storage, tenant, workspace, op.path);
      if (!existed) {
        sendError(res, 404, 'not_found', 'No such workspace file.');
        return;
      }
      res.status(204).end();
      return;
    }
  }
}

export function registerWorkspaceRoutes(app: Express, storage: Storage): void {
  app.get('/v1/host/workspace/files', async (req, res, next) => {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : undefined;
    try {
      await applyOp(storage, res, ownerOf(req), { kind: 'list', ...(prefix !== undefined ? { prefix } : {}) });
    } catch (err) { next(err); }
  });

  app.get('/v1/host/workspace/files/:path', async (req, res, next) => {
    try {
      await applyOp(storage, res, ownerOf(req), { kind: 'get', path: req.params.path });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/workspace/files/:path', async (req, res, next) => {
    const body = (req.body ?? {}) as { content?: unknown; contentType?: unknown };
    if (typeof body.content !== 'string') {
      sendError(res, 400, 'validation_error', 'content (string) required');
      return;
    }
    const im = ifMatch(req);
    try {
      await applyOp(storage, res, ownerOf(req), {
      kind: 'put',
      path: req.params.path,
      content: body.content,
      ...(typeof body.contentType === 'string' ? { contentType: body.contentType } : {}),
      ...(im !== undefined ? { ifMatch: im } : {}),
    });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/workspace/files/:path', async (req, res, next) => {
    try {
      await applyOp(storage, res, ownerOf(req), { kind: 'delete', path: req.params.path });
    } catch (err) { next(err); }
  });

  log.info('workspace CRUD routes registered (RFC 0059 §C: /v1/host/workspace/files)');

  // RFC 0059 §E WCT-1 cross-owner seam — owner from the BODY so a single
  // conformance credential can drive distinct `{tenant, workspace}` pairs.
  // SECURITY: because the owner is caller-supplied (not the authenticated
  // identity), this seam bypasses the WCT-1 owner binding and MUST NOT be
  // exposed in production — it is gated on OPENWOP_TEST_SEAM_ENABLED (OFF by
  // default). The real CRUD endpoints above derive the owner from
  // req.tenantId and are always safe to expose. Vendor-namespaced under
  // /v1/host/openwop-app/* per host-extensions.md.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('workspace cross-owner seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  log.warn('workspace cross-owner seam ENABLED — /v1/host/openwop-app/workspace/op accepts a body-supplied owner. NEVER enable in production.');
  app.post('/v1/host/openwop-app/workspace/op', async (req, res, next) => {
    const body = (req.body ?? {}) as {
      tenant?: unknown;
      workspace?: unknown;
      op?: unknown;
      path?: unknown;
      content?: unknown;
      contentType?: unknown;
      ifMatch?: unknown;
      prefix?: unknown;
    };
    if (typeof body.tenant !== 'string' || typeof body.workspace !== 'string') {
      sendError(res, 400, 'validation_error', 'tenant + workspace required');
      return;
    }
    const owner = { tenant: body.tenant, workspace: body.workspace };
    const path = typeof body.path === 'string' ? body.path : '';
    switch (body.op) {
      case 'list':
        try {
      await applyOp(storage, res, owner, { kind: 'list', ...(typeof body.prefix === 'string' ? { prefix: body.prefix } : {}) });
    } catch (err) { next(err); }
        return;
      case 'get':
        try {
      await applyOp(storage, res, owner, { kind: 'get', path });
    } catch (err) { next(err); }
        return;
      case 'put':
        if (typeof body.content !== 'string') {
          sendError(res, 400, 'validation_error', 'content required for put');
          return;
        }
        try {
      await applyOp(storage, res, owner, {
          kind: 'put',
          path,
          content: body.content,
          ...(typeof body.contentType === 'string' ? { contentType: body.contentType } : {}),
          ...(typeof body.ifMatch === 'string' ? { ifMatch: body.ifMatch } : {}),
        });
    } catch (err) { next(err); }
        return;
      case 'delete':
        try {
      await applyOp(storage, res, owner, { kind: 'delete', path });
    } catch (err) { next(err); }
        return;
      default:
        sendError(res, 400, 'validation_error', 'op must be list|get|put|delete');
    }
  });
}
