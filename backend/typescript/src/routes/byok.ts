/**
 * Host-extension BYOK secret-management routes.
 *
 *   GET    /v1/host/openwop-app/byok/secrets             — list stored refs (NEVER values)
 *   POST   /v1/host/openwop-app/byok/secrets             — { credentialRef, value } → stored
 *   DELETE /v1/host/openwop-app/byok/secrets/:credentialRef
 *
 * Namespace: these routes live under `/v1/host/openwop-app/*` per
 * `spec/v1/host-extensions.md` §"Canonical prefixes" — they are NOT
 * part of the OpenWOP v1 wire contract, so they MUST live under a
 * vendor-prefixed path so a future spec version that defines its own
 * BYOK key-management surface doesn't collide. Adopters replacing the
 * sample with their own host should pick their own prefix
 * (`/v1/host/<your-vendor>/byok/...`).
 *
 * Storage: keys persist to sqlite + AES-256-GCM at rest via
 * `src/byok/encryption.ts`. Real deployers swap for KMS — the route
 * shape stays the same.
 *
 * Auth: every route requires a valid Bearer token (handled by the
 * global auth middleware).
 */

import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { listSecretRefs, removeSecret, setSecret, type SecretScope } from '../byok/secretResolver.js';
import { getHeadlessAiDefault, setHeadlessAiDefault, clearHeadlessAiDefault } from '../host/headlessAi.js';

interface SetSecretRequest {
  credentialRef?: unknown;
  value?: unknown;
}

const REF_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

function scopeFromReq(req: import('express').Request): { tenantId: string; actorId?: string } | undefined {
  // In ephemeral mode the resolver needs a tenantId. Pull it from the
  // session-cookie-derived req.tenantId set by the auth middleware.
  // Bearer-authed callers (tenants: ['*']) get no scope, falling back
  // to the SQLite path which is global.
  // Stamp the initiating principal so secret mutations are attributable in
  // the audit log (SEC-4).
  return req.tenantId ? { tenantId: req.tenantId, actorId: req.principal?.principalId } : undefined;
}

export function registerByokRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/byok/secrets', async (req, res, next) => {
    try {
      res.json({ credentialRefs: await listSecretRefs(scopeFromReq(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/byok/secrets', async (req, res, next) => {
    try {
      const body = req.body as SetSecretRequest;
      if (!body || typeof body !== 'object') {
        throw new OpenwopError('validation_error', 'Request body MUST be a JSON object.', 400);
      }
      if (typeof body.credentialRef !== 'string' || !REF_PATTERN.test(body.credentialRef)) {
        throw new OpenwopError(
          'validation_error',
          'Field `credentialRef` MUST match [a-zA-Z0-9_.-:]{1,128}.',
          400,
          { field: 'credentialRef' },
        );
      }
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw new OpenwopError(
          'validation_error',
          'Field `value` MUST be a non-empty string.',
          400,
          { field: 'value' },
        );
      }
      await setSecret(body.credentialRef, body.value, scopeFromReq(req));
      // Echo back ONLY the ref + a masked preview. Never the value.
      res.status(201).json({
        credentialRef: body.credentialRef,
        masked: maskInline(body.value),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/byok/secrets/:credentialRef', async (req, res, next) => {
    try {
      const ref = req.params.credentialRef;
      if (!REF_PATTERN.test(ref)) {
        throw new OpenwopError('validation_error', 'Invalid credentialRef.', 400, { credentialRef: ref });
      }
      await removeSecret(ref, scopeFromReq(req));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ── Headless AI default (ADR 0110) — a tenant binding {provider, model, credentialRef}
  // pointing at one of the tenant's own BYOK secrets, used when a headless op (KB media→text)
  // needs a multimodal model the managed provider (MiniMax, text-only) doesn't offer. Lives
  // under /byok/ because it is BYOK config; same session-tenant scope as the secrets above.
  const tenantScope = (req: import('express').Request): SecretScope => {
    const s = scopeFromReq(req);
    if (!s) throw new OpenwopError('unauthenticated', 'Authentication required.', 401);
    return s;
  };

  app.get('/v1/host/openwop-app/byok/ai-default', async (req, res, next) => {
    try {
      res.json({ default: await getHeadlessAiDefault(tenantScope(req).tenantId) });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/byok/ai-default', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown };
      const saved = await setHeadlessAiDefault(tenantScope(req), body, new Date().toISOString());
      res.status(200).json({ default: saved });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/byok/ai-default', async (req, res, next) => {
    try {
      await clearHeadlessAiDefault(tenantScope(req).tenantId);
      res.status(204).send();
    } catch (err) { next(err); }
  });
}

function maskInline(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
