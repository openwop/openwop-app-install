/**
 * ADR 0139 — the nav-config provider + resolution hooks.
 *
 * Holds the fetched (tenant ← user) `MenuConfigBundle` and exposes:
 *   - `useNavConfig()`  — the raw bundle + loading + save/reload mutators (the editor).
 *   - `useResolvedNav()`— the effective { workspace, admin } rails, the declared
 *     FEATURES nav overlaid with the bundle and gated by the live feature access.
 *
 * Initial bundle is empty, so the first paint (before the fetch resolves, or for
 * an anonymous caller whose GET 401s) renders today's declared menu — no flash.
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

// The network client is lazy-imported (kept out of the first-paint entry chunk):
// it's only called from effects/handlers, never at module-eval, and the nav
// renders from the declared FEATURES until the fetch resolves.
const client = () => import('./menuConfigClient.js');

interface NavConfigValue {
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
  reload: () => {},
  saveTenant: async () => {},
  saveUser: async () => {},
});

export function NavConfigProvider({ children }: { children: ReactNode }): JSX.Element {
  const [bundle, setBundle] = useState<MenuConfigBundle>(EMPTY_MENU_CONFIG_BUNDLE);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void client().then((m) => m.getMenuConfig()).then((b) => { setBundle(b); setLoading(false); });
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
    () => ({ bundle, loading, reload, saveTenant, saveUser }),
    [bundle, loading, reload, saveTenant, saveUser],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNavConfig(): NavConfigValue {
  return useContext(Ctx);
}

/** The effective, feature-gated workspace + admin rails. */
export function useResolvedNav(): ResolvedNav {
  const { bundle } = useContext(Ctx);
  const isVisible = useFeatureVisible();
  return resolveNav({ features: FEATURES, tenant: bundle.tenant, user: bundle.user, access: isVisible });
}
