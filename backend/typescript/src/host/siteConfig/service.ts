/**
 * Site configuration (ADR 0027) — a durable SINGLETON: whether the public front
 * page is served at `/` to anonymous visitors. The CONTENT is always the
 * host-level system home page (`host/systemSite.ts`), edited by the super admin —
 * so this config is just the on/off switch, not an org pointer (Option A: the
 * homepage is host-level content with host-level authority, never tenant-scoped).
 *
 * The WRITE path is superadmin-gated (`routes/siteConfig.ts`); the public READ
 * exposes only `{ enabled, orgId, slug }` where orgId/slug are the fixed system
 * site ids — no tenant data, no secrets.
 */
import { DurableCollection } from '../hostExtPersistence.js';

export interface SiteConfig {
  /** Singleton key — always `'site'`. */
  id: 'site';
  /** Whether the public front page is served at `/` (else `/` is the app). */
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

const SINGLETON = 'site';
const store = new DurableCollection<SiteConfig>('site-config', (c) => c.id);

/** Whether the front page is ON when nothing has been configured yet. ON by
 *  default (the app ships with a seeded, editable home page); a white-label fork
 *  that wants '/' to be the app by default sets OPENWOP_FRONTPAGE_DEFAULT_ENABLED=false.
 *  A superadmin's saved config always wins over this default. */
function defaultEnabled(): boolean {
  return process.env.OPENWOP_FRONTPAGE_DEFAULT_ENABLED !== 'false';
}

/** The current site config, or the (ON-by-default) default when never set. */
export async function getSiteConfig(): Promise<SiteConfig> {
  return (await store.get(SINGLETON)) ?? {
    id: SINGLETON, enabled: defaultEnabled(), updatedBy: '', updatedAt: '',
  };
}

/** Upsert the on/off switch (caller gates superadmin first). */
export async function setSiteConfig(input: { enabled: boolean }, updatedBy: string): Promise<SiteConfig> {
  const next: SiteConfig = { id: SINGLETON, enabled: input.enabled, updatedBy, updatedAt: new Date().toISOString() };
  await store.put(next);
  return next;
}
