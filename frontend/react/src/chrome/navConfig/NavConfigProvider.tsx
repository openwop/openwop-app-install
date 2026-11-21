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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  const live = useRef(false);
  const epoch = useRef(0);
  const issued = useRef(0);

  const reload = useCallback(() => {
    const owner = epoch.current;
    const request = ++issued.current;
    const current = (): boolean => live.current && owner === epoch.current && request === issued.current;
    setLoading(true);
    setFailed(false);
    setBundle(EMPTY_MENU_CONFIG_BUNDLE);
    void client().then((m) => current() ? m.getMenuConfig() : null)
      .then((b) => {
        if (!current() || b === null) return;
        setBundle(b); setFailed(false); setLoading(false);
      })
      .catch(() => {
        if (!current()) return;
        setFailed(true); setLoading(false);
      });
  }, []);

  useEffect(() => {
    live.current = true;
    epoch.current += 1;
    reload();
    const unsubscribe = onAuthChange(() => {
      epoch.current += 1;
      reload();
    });
    return () => {
      live.current = false;
      epoch.current += 1;
      unsubscribe();
    };
  }, [reload]);

  const saveTenant = useCallback(async (cfg: MenuConfig) => {
    const owner = epoch.current;
    const api = await client();
    if (!live.current || owner !== epoch.current) return;
    const saved = await api.putTenantMenuConfig(cfg);
    if (!live.current || owner !== epoch.current) return;
    setBundle((b) => ({ ...b, tenant: saved }));
  }, []);

  const saveUser = useCallback(async (cfg: MenuConfig) => {
    const owner = epoch.current;
    const api = await client();
    if (!live.current || owner !== epoch.current) return;
    const saved = await api.putMyMenuConfig(cfg);
    if (!live.current || owner !== epoch.current) return;
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
