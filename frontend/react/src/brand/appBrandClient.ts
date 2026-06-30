/**
 * App-brand client (ADR 0170) — the super-admin Appearance editor talks to the
 * host-level `/v1/host/openwop-app/app-brand` route (GET working copy + PUT). Uses
 * the shared `requestJson` helper, which throws a structured `ApiError` (`.status`
 * → 403 maps to the read-only "not a super admin" notice).
 */
import { requestJson } from '../client/requestJson.js';
import type { PublicBrandIdentity } from './applyBrand.js';

export interface AppBrand {
  id: string;
  name: string;
  description: string;
  identity?: PublicBrandIdentity;
}

export async function getAppBrand(): Promise<AppBrand> {
  const r = await requestJson<{ brand: AppBrand }>('/v1/host/openwop-app/app-brand');
  return r.brand;
}

export async function putAppBrand(patch: { name?: string; identity?: PublicBrandIdentity }): Promise<AppBrand> {
  const r = await requestJson<{ brand: AppBrand }>('/v1/host/openwop-app/app-brand', { method: 'PUT', json: patch });
  return r.brand;
}
