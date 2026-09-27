/**
 * The host-global system site org id — split out of `cmsClient.ts` (entry-chunk structural split — bundle-budget headroom)
 * so the PublicShell (entry chunk, every first paint) can read ONE constant
 * without pulling the whole CMS client (≈7 kB raw) into the entry.
 * `cmsClient.ts` re-exports it, so existing importers are unchanged.
 */
export const SYSTEM_SITE_ORG = 'host-site';
