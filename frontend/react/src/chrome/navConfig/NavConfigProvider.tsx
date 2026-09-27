/**
 * ADR 0139 — the nav-config provider + resolution hooks.
 *
 * Holds the fetched (tenant ← user) `MenuConfigBundle` and exposes:
 *   - `useNavConfig()`  — the raw bundle + loading + save/reload mutators (the editor).
 *   - `useResolvedNav()`— the effective { workspace, admin } rails, the declared
 *     FEATURES nav overlaid with the bundle and gated by the live feature access.
 *
 * Initial bundle is empty, so the first paint before the fetch resolves renders
 * today's declared menu without a flash. The host route permits anonymous reads
 * of that caller's own tenant layer; actual failures retain the safe declared
 * menu while `failed` makes the degradation visible.
 * Resolution is cheap (O(nav items)); computed per render rather than memoized on
 * the per-render `useFeatureVisible` identity.
 *
 * @see docs/adr/0139-configurable-navigation-menu.md
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FEATURES } from '../features.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { onAuthChange } from '../../client/config.js';
import { resolveNav, type ResolvedNav } from './resolveNav.js';
import { EMPTY_MENU_CONFIG_BUNDLE, type MenuConfig, type MenuConfigBundle } from './types.js';
import { isAdminCaller, useEffectiveAccessState } from '../../client/useEffectiveAccess.js';

// The network client is lazy-imported (kept out of the first-paint entry chunk):
// it's only called from effects/handlers, never at module-eval, and the nav
// renders from the declared FEATURES until the fetch resolves.
const client = () => import('./menuConfigClient.js');

interface NavConfigValue {
  /** The menu-config read failed — consumers may disclose it. */
  failed: boolean;
  bundle: MenuConfigBundle;
  loading: boolean;
  reload: () => void;
  /** Save the shared workspace default (superadmin) + adopt it locally. */
  saveTenant: (cfg: MenuConfig) => Promise<void>;
  /** Save the caller's personalization + adopt it locally. */
  saveUser: (cfg: MenuConfig) => Promise<void>;
}

const Ctx = createContext<NavConfigValue>({
  bundle: EMPTY_MENU_CONFIG_BUNDLE,
  loading: false,
  failed: false,
  reload: () => {},
  saveTenant: async () => {},
  saveUser: async () => {},
});

export function NavConfigProvider({ children }: { children: ReactNode }): JSX.Element {
  const [bundle, setBundle] = useState<MenuConfigBundle>(EMPTY_MENU_CONFIG_BUNDLE);
  const [loading, setLoading] = useState(true);
  /** The menu-config read FAILED — distinct from "this tenant has no overrides",
   *  which is what the EMPTY bundle legitimately means. */
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    // NO `.catch` here meant an unhandled rejection AND `setLoading(false)` never
    // running — so `/menu-settings` sat on its loading card forever and this
    // provider, which wraps the whole app, silently kept the EMPTY bundle. The
    // empty bundle is the right fallback for NAV (better a default menu than
    // none); what was missing is that anyone could tell it had happened.
    void client().then((m) => m.getMenuConfig())
      .then((b) => { setBundle(b); setFailed(false); setLoading(false); })
      .catch(() => { setFailed(true); setLoading(false); });
  }, []);

  // Initial load + refetch whenever the auth identity changes (sign-in/out): the
  // per-user layer is identity-scoped, so a fresh login must re-resolve.
  useEffect(() => {
    reload();
    return onAuthChange(() => reload());
  }, [reload]);

  const saveTenant = useCallback(async (cfg: MenuConfig) => {
    const saved = await (await client()).putTenantMenuConfig(cfg);
    setBundle((b) => ({ ...b, tenant: saved }));
  }, []);

  const saveUser = useCallback(async (cfg: MenuConfig) => {
    const saved = await (await client()).putMyMenuConfig(cfg);
    setBundle((b) => ({ ...b, user: saved }));
  }, []);

  const value = useMemo<NavConfigValue>(
    () => ({ bundle, loading, reload, saveTenant, saveUser, failed}),
    [bundle, loading, reload, saveTenant, saveUser, failed],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNavConfig(): NavConfigValue {
  return useContext(Ctx);
}

/** The effective, feature-gated workspace + admin rails. */
export function useResolvedNav(): ResolvedNav & { degraded: boolean } {
  const { bundle, failed } = useContext(Ctx);
  const isVisible = useFeatureVisible();
  const { access } = useEffectiveAccessState();
  return {
    ...resolveNav({
      features: FEATURES,
      tenant: bundle.tenant,
      user: bundle.user,
      access: isVisible,
      authority: {
        admin: isAdminCaller(access),
        superadmin: access.superadmin === true,
        scopes: access.scopes,
      },
    }),
    degraded: failed,
  };
}
