/**
 * Runtime brand provider (ADR 0170 Phase 5). On mount it fetches the app identity
 * from the public host route, applies it to the DOM (`:root` tokens, title,
 * favicon, fonts), merges it onto the `brand` singleton, and caches it for the next
 * load's pre-paint hydrate. A version bump re-renders `useBrand()` consumers so the
 * header wordmark / logo reflect a super-admin override live.
 *
 * Fetch failure is non-fatal: the build-time identity (index.html placeholders +
 * the `brand` singleton from `VITE_BRAND_*`) stays in place. The public route is
 * unauthenticated, so this runs before login on the shell + gate.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { config } from '../client/config.js';
import { brand } from './brand.js';
import type { BrandConfig } from './defaults.js';
import {
  applyBrandIdentity,
  applyGeneratedTokens,
  cacheGeneratedTokens,
  cacheIdentity,
  clearGeneratedTokens,
  hasGenerativeTheme,
  hydrateBrandSingleton,
  toThemeInputs,
  type PublicBrandIdentity,
} from './applyBrand.js';

/** Context carries a version counter — bumped once the runtime identity loads. */
const BrandVersionContext = createContext(0);

export function BrandProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/public-brand`, { credentials: 'omit' });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { identity?: PublicBrandIdentity };
        const identity = body.identity ?? {};
        applyBrandIdentity(identity);
        hydrateBrandSingleton(identity);
        cacheIdentity(identity);
        // ADR 0171: if the brand carries generative theme inputs, lazy-load the
        // generator (kept off the entry chunk), produce the full light/dark token
        // set, layer the advanced override, apply + cache it for the next pre-paint.
        if (hasGenerativeTheme(identity.theme)) {
          const { generateTheme } = await import('./theme/generate.js');
          if (cancelled) return;
          const t = generateTheme(toThemeInputs(identity.theme));
          const light = { ...t.light, ...identity.theme?.override?.light };
          const dark = { ...t.dark, ...identity.theme?.override?.dark };
          applyGeneratedTokens(light, dark);
          cacheGeneratedTokens(light, dark);
        } else {
          clearGeneratedTokens(); // no generative theme server-side → drop any stale cache
        }
        if (!cancelled) setVersion((v) => v + 1);
      } catch {
        /* offline / unreachable — keep the build-time identity */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return <BrandVersionContext.Provider value={version}>{children}</BrandVersionContext.Provider>;
}

/** The effective brand. Re-renders the caller when a runtime override loads. */
export function useBrand(): BrandConfig {
  useContext(BrandVersionContext); // subscribe → re-render on the version bump
  return brand;
}
