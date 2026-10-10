/**
 * The media-asset serve address, SPA side. It mirrors
 * `backend/typescript/src/host/assetServePath.ts`: one owner, version-neutral.
 *
 * Content stored before the backend minted unversioned URLs (run event logs,
 * which are append-only history) still carries `/v1/host/openwop-app/assets/…`.
 * That address 410s once v1 retires (ADR 0669), so every place the SPA RENDERS
 * or FETCHES an asset URL canonicalises it here first. Any `/v<N>` is
 * recognised, so the next major needs no edit.
 */
export const ASSET_SERVE_PATH = '/host/openwop-app/assets';

/** A root-relative serve path with an optional `/v<N>`. Token shape only: no `/` or `.`. */
export const ASSET_SERVE_PATH_RE = /^(?:\/v[0-9]+)?\/host\/openwop-app\/assets\/[A-Za-z0-9_-]{1,512}$/;

/** Drop any versioned prefix in front of the serve path, in a relative or absolute URL. */
export function canonicalAssetPath(url: string): string {
  return url.replace(/\/v[0-9]+(?=\/host\/openwop-app\/assets\/)/, '');
}
