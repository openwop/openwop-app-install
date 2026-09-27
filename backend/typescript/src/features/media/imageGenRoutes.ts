/**
 * AI image-generation routes (ADR 0401 P1) — the editor-facing reach onto the
 * ONE ADR 0115 image dispatch. Media owns them because media owns every byte:
 * a generated image immediately becomes a durable, org-scoped LIBRARY asset
 * (hash-deduped, capacity-gated, provenance-stamped) whose serve URL the
 * editor sets on a `mediaRef` prop through the existing doc-validate persist.
 *
 *   GET  …/media/orgs/:orgId/image-providers     which providers have a tenant
 *                                                BYOK key (honest-off input for
 *                                                the dialog)      [workspace:read]
 *   POST …/media/orgs/:orgId/assets/generate     prompt → callImageGenerator →
 *                                                durable library asset(s)
 *                                                                 [workspace:write]
 *
 * The dispatch stays host-side (the AdapterScope is synthetic — the voice/chat
 * precedent): the tenant key resolves via `resolveSecret`, feeds
 * `createAiProvidersAdapter`, and NEVER crosses to the client; only asset ids +
 * serve URLs do. No second dispatch path, no client-side provider call
 * (ADR 0401 Alternatives §1/§2).
 */

import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { requireOrgScope, requireString, optionalString } from '../featureRoute.js';
import { createAiProvidersAdapter, AiProviderError } from '../../aiProviders/aiProvidersHost.js';
import { NATIVE_IMAGE_PROVIDERS, IMAGE_OP_SUPPORT } from '../../providers/dispatchImages.js';
import { resolveSecret, listSecretRefs } from '../../byok/secretResolver.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import * as mediaStorage from './mediaStorage.js';
import { assertOrgCapacity, createAsset, findAssetByContentHash, getAsset, mergeAssetMetadataOnDedup, viewAsset, type MediaAssetLineage } from './mediaService.js';

const MAX = { prompt: 4_000, model: 200, n: 4 } as const;

/** Does this stored credential ref belong to `provider`? Mirrors the adapter's
 *  own fallback matching (`resolveCredential`) so the dialog's provider list
 *  and the dispatch agree. */
function refMatchesProvider(ref: string, provider: string): boolean {
  return ref === provider || ref.startsWith(`${provider}-`) || ref.startsWith(`${provider}:`);
}

/** Map the adapter's typed failure onto the route envelope without losing the
 *  taxonomy (and never echoing credential material — the adapter already
 *  guarantees that). */
function toRouteError(err: AiProviderError): OpenwopError {
  // Provider taxonomy → the canonical route envelope. The original adapter
  // code stays visible in `details.providerCode` so nothing is lossy.
  const mapped: { code: 'invalid_request' | 'rate_limited' | 'host_capability_missing' | 'credential_unavailable'; status: number } =
    err.code === 'invalid_request' || err.code === 'content_too_long' ? { code: 'invalid_request', status: 400 }
      : err.code === 'provider_rate_limited' ? { code: 'rate_limited', status: 429 }
        : err.code === 'byok_required_but_unresolved' ? { code: 'credential_unavailable', status: 409 }
          : { code: 'host_capability_missing', status: err.code === 'host_capability_missing' ? 409 : 502 };
  return new OpenwopError(mapped.code, err.message, mapped.status, { ...(err.details ?? {}), providerCode: err.code });
}

export function registerImageGenRoutes(deps: RouteDeps): void {
  const { app, hostSuite } = deps;
  const BASE = '/v1/host/openwop-app/media/orgs/:orgId';

  // Which image providers can this tenant actually dispatch to? (BYOK-honest:
  // a provider appears ONLY with a stored tenant key — the dialog renders an
  // honest-off state when the list is empty.)
  app.get(`${BASE}/image-providers`, async (req, res, next) => {
    try {
      // ADR 0027 — Media is always-on; the org-RBAC gate is the whole gate.
      const { tenantId } = await requireOrgScope(req, 'workspace:read');
      const refs = await listSecretRefs({ tenantId: tenantId });
      const providers = NATIVE_IMAGE_PROVIDERS
        .map((provider) => ({ provider, credentialRefs: refs.filter((r) => refMatchesProvider(r, provider)), ops: [...(IMAGE_OP_SUPPORT[provider] ?? [])] }))
        .filter((p) => p.credentialRefs.length > 0);
      res.json({ providers });
    } catch (err) { next(err); }
  });

  // Generate → durable library asset(s). Bytes never cross to the client; the
  // response carries the library view (assetId + serve URL + provenance).
  app.post(`${BASE}/assets/generate`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      const body = (req.body ?? {}) as { prompt?: unknown; provider?: unknown; model?: unknown; size?: unknown; n?: unknown; credentialRef?: unknown; collectionId?: unknown };
      const prompt = requireString(body.prompt, 'prompt');
      if (prompt.length > MAX.prompt) {
        throw new OpenwopError('validation_error', `\`prompt\` exceeds ${MAX.prompt} characters.`, 400, { field: 'prompt' });
      }
      const provider = optionalString(body.provider) ?? 'openai';
      // 'mock' passes through ONLY under the test seam (the adapter enforces the
      // same defense-in-depth — in prod it falls to honest capability-missing).
      const allowMock = provider === 'mock' && process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
      if (!allowMock && !(NATIVE_IMAGE_PROVIDERS as readonly string[]).includes(provider)) {
        throw new OpenwopError('validation_error', `\`provider\` must be one of: ${NATIVE_IMAGE_PROVIDERS.join(', ')}.`, 400, { field: 'provider' });
      }
      const n = Math.min(Math.max(1, typeof body.n === 'number' && Number.isFinite(body.n) ? Math.floor(body.n) : 1), MAX.n);

      // Resolve the tenant's key for the chosen provider (explicit ref wins;
      // else the same prefix rule the adapter uses). Missing ⇒ honest 409.
      let credentialRef = optionalString(body.credentialRef);
      if (credentialRef && !refMatchesProvider(credentialRef, provider)) {
        throw new OpenwopError('validation_error', '`credentialRef` does not belong to the chosen provider.', 400, { field: 'credentialRef' });
      }
      if (!credentialRef) {
        const refs = await listSecretRefs({ tenantId: tenantId });
        credentialRef = refs.find((r) => refMatchesProvider(r, provider));
      }
      const apiKey = allowMock ? 'mock' : credentialRef ? await resolveSecret(credentialRef, { tenantId: tenantId }) : null;
      if (allowMock) credentialRef = 'mock';
      if (!credentialRef || !apiKey) {
        throw new OpenwopError('host_capability_missing', `No stored ${provider} credential for this workspace — add one under Providers.`, 409, { provider });
      }

      const adapter = createAiProvidersAdapter({
        runId: `images:route:${randomUUID()}`,
        nodeId: 'images.generate',
        tenantId,
        actingUserId: user.userId,
        attempt: 1,
        secrets: { [credentialRef]: apiKey },
        policyResolver: hostSuite.providerPolicyResolver,
      });

      let result;
      try {
        result = await adapter.callImageGenerator({
          prompt, provider, n, credentialRef,
          ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
          ...(optionalString(body.size) ? { size: optionalString(body.size) } : {}),
        });
      } catch (err) {
        if (err instanceof AiProviderError) throw toRouteError(err);
        throw err;
      }

      // Re-store each scratch asset on the DURABLE library path (the media
      // surface's createAssetFromServeUrl shape): hash-dedup, capacity gate
      // BEFORE storing, provenance lineage. ADR 0352 renditions/select apply
      // to the new row unchanged.
      const assets = [];
      for (const img of result.images) {
        const token = img.url.match(/\/assets\/([A-Za-z0-9_-]{1,512})\/?$/)?.[1];
        const entry = token ? await resolveMediaAsset(token) : null;
        if (!entry || entry.tenantId !== tenantId) continue; // defensive — the adapter minted it for this tenant
        const contentHash = createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');
        const lineage = { generatedBy: 'ai', prompt: prompt.slice(0, 500), provider, ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}), op: 'generate' };
        const existing = await findAssetByContentHash(tenantId, orgId, contentHash);
        if (existing) {
          assets.push(viewAsset(await mergeAssetMetadataOnDedup(existing, {})));
          continue;
        }
        await assertOrgCapacity(tenantId, orgId, entry.bytes);
        const stored = await mediaStorage.put(tenantId, { contentBase64: entry.contentBase64, contentType: entry.contentType });
        const asset = await createAsset({
          tenantId,
          orgId,
          ...(optionalString(body.collectionId) ? { collectionId: optionalString(body.collectionId) } : {}),
          name: `${prompt.replace(/[^\w .-]/g, ' ').trim().slice(0, 80) || 'generated image'}.png`,
          contentType: entry.contentType,
          sizeBytes: stored.sizeBytes,
          storageRef: stored.storageRef,
          serveToken: stored.serveToken,
          tags: ['ai-generated'],
          uploadedBy: user.userId,
          lineage,
          contentHash,
        });
        assets.push(viewAsset(asset));
      }
      if (assets.length === 0) {
        throw new OpenwopError('host_capability_missing', 'The provider returned no images.', 502, { provider });
      }
      res.status(201).json({ assets });
    } catch (err) { next(err); }
  });

  /** Shared plumbing for the two derive ops: resolve the SOURCE asset's bytes
   *  (tenant+org IDOR via getAsset), run the cap, re-store the result as a NEW
   *  durable asset with `derivedFrom` lineage (never mutate the source — dedup
   *  + rendition lineage + replay depend on immutability, ADR 0401 §a). */
  async function deriveAsset(
    req: Request,
    res: Response,
    run: (args: { user: { tenantId: string; userId: string }; source: { contentBase64: string; contentType: string }; body: Record<string, unknown>; credentialRef: string; apiKey: string; adapter: ReturnType<typeof createAiProvidersAdapter> }) => Promise<{ result: { images: Array<{ url: string; mimeType: string }> }; lineage: MediaAssetLineage; nameSuffix: string }>,
  ): Promise<void> {
    const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = await getAsset(tenantId, orgId, req.params.assetId ?? '');
    if (!source) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
    const entry = await resolveMediaAsset(source.serveToken);
    if (!entry || entry.tenantId !== tenantId) throw new OpenwopError('not_found', 'Asset bytes unavailable.', 404, {});

    const provider = optionalString(body.provider) ?? 'replicate';
    const allowMock = provider === 'mock' && process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
    if (!allowMock && !(NATIVE_IMAGE_PROVIDERS as readonly string[]).includes(provider)) {
      throw new OpenwopError('validation_error', `\`provider\` must be one of: ${NATIVE_IMAGE_PROVIDERS.join(', ')}.`, 400, { field: 'provider' });
    }
    let credentialRef = optionalString(body.credentialRef);
    if (!credentialRef && !allowMock) {
      const refs = await listSecretRefs({ tenantId: tenantId });
      credentialRef = refs.find((r) => refMatchesProvider(r, provider));
    }
    const apiKey = allowMock ? 'mock' : credentialRef ? await resolveSecret(credentialRef, { tenantId: tenantId }) : null;
    if (allowMock) credentialRef = 'mock';
    if (!credentialRef || !apiKey) {
      throw new OpenwopError('host_capability_missing', `No stored ${provider} credential for this workspace — add one under Providers.`, 409, { provider });
    }
    const adapter = createAiProvidersAdapter({
      runId: `images:route:${randomUUID()}`,
      nodeId: 'images.derive',
      tenantId,
      actingUserId: user.userId,
      attempt: 1,
      secrets: { [credentialRef]: apiKey },
      policyResolver: hostSuite.providerPolicyResolver,
    });

    let derived;
    try {
      derived = await run({ user, source: { contentBase64: entry.contentBase64, contentType: entry.contentType }, body, credentialRef, apiKey, adapter });
    } catch (err) {
      if (err instanceof AiProviderError) throw toRouteError(err);
      throw err;
    }

    const assets = [];
    for (const img of derived.result.images) {
      const token = img.url.match(/\/assets\/([A-Za-z0-9_-]{1,512})\/?$/)?.[1];
      const out = token ? await resolveMediaAsset(token) : null;
      if (!out || out.tenantId !== tenantId) continue;
      const contentHash = createHash('sha256').update(Buffer.from(out.contentBase64, 'base64')).digest('hex');
      const existing = await findAssetByContentHash(tenantId, orgId, contentHash);
      if (existing) { assets.push(viewAsset(await mergeAssetMetadataOnDedup(existing, {}))); continue; }
      await assertOrgCapacity(tenantId, orgId, out.bytes);
      const stored = await mediaStorage.put(tenantId, { contentBase64: out.contentBase64, contentType: out.contentType });
      const asset = await createAsset({
        tenantId, orgId,
        name: `${source.name.replace(/\.[a-z0-9]{1,8}$/i, '')}${derived.nameSuffix}.png`,
        contentType: out.contentType,
        sizeBytes: stored.sizeBytes,
        storageRef: stored.storageRef,
        serveToken: stored.serveToken,
        tags: ['ai-generated'],
        uploadedBy: user.userId,
        lineage: { ...derived.lineage, derivedFrom: source.assetId, generatedBy: 'ai', provider },
        contentHash,
      });
      assets.push(viewAsset(asset));
    }
    if (assets.length === 0) throw new OpenwopError('host_capability_missing', 'The provider returned no images.', 502, { provider });
    res.status(201).json({ assets });
  }

  // Edit / inpaint / background-remove an existing library asset (ADR 0401 §b).
  app.post(`${BASE}/assets/:assetId/ai-edit`, (req, res, next) => {
    deriveAsset(req, res, async ({ source, body, credentialRef, adapter }) => {
      const op = optionalString(body.op) ?? 'edit';
      if (op !== 'edit' && op !== 'inpaint' && op !== 'background-remove') {
        throw new OpenwopError('validation_error', '`op` must be edit | inpaint | background-remove.', 400, { field: 'op' });
      }
      const prompt = optionalString(body.prompt);
      const result = await adapter.callImageEditor({
        imageBase64: source.contentBase64,
        mimeType: source.contentType,
        op,
        ...(prompt ? { prompt } : {}),
        ...(optionalString(body.maskBase64) ? { maskBase64: optionalString(body.maskBase64) } : {}),
        provider: optionalString(body.provider) ?? 'replicate',
        ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
        credentialRef,
      });
      return {
        result,
        lineage: { op, ...(prompt ? { prompt: prompt.slice(0, 500) } : {}), ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}) },
        nameSuffix: op === 'background-remove' ? ' (no bg)' : ` (${op})`,
      };
    }).catch(next);
  });

  // 2×/4× upscale (ADR 0401 §b) — a NEW asset with lineage, never a mutation.
  app.post(`${BASE}/assets/:assetId/ai-upscale`, (req, res, next) => {
    deriveAsset(req, res, async ({ source, body, credentialRef, adapter }) => {
      const scale = body.scale === 4 ? 4 : 2;
      const result = await adapter.callImageUpscaler({
        imageBase64: source.contentBase64,
        mimeType: source.contentType,
        scale,
        provider: optionalString(body.provider) ?? 'replicate',
        ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
        credentialRef,
      });
      return {
        result,
        lineage: { op: 'upscale', ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}) },
        nameSuffix: ` (${scale}x)`,
      };
    }).catch(next);
  });
}
