/**
 * ADR 0824 D3/D5 — what the reference deployment's public site says about
 * ITSELF to answer engines: the site name, the Organization's `sameAs`, the
 * home page's SoftwareApplication + VideoObject, and the `/llms.txt` preamble.
 *
 * One data module, read by the crawler prerender (`prerenderService.ts`) and
 * the llms.txt door (`features/docs/routes.ts`). It is the smallest seam that
 * keeps the generic publishing renderer generic: any other org gets exactly the
 * output it got before (`null` here).
 *
 * DEMO-GATED (ADR 0196 Gate A), like the hero film itself: the film and every
 * OpenWOP-identity claim below belong to the public showcase deployment. A
 * clean / white-label install (`OPENWOP_DEMO_MODE` off) renders no film, so it
 * must not advertise one, nor claim to be OpenWOP.
 *
 * Copy rules: the PROTOCOL is open source, this app is not; none of the gated
 * assurance claims (openwop-site `check-claims.mjs`).
 *
 * ADR 0931 — a distribution replaces all of this with its own profile
 * (`OPENWOP_SYSTEM_SITE_PROFILE`, `systemSiteConfig.ts`). A configured profile
 * applies in or out of demo mode, because it is the distribution describing
 * itself. A profile that is set but invalid yields `null` (the generic output),
 * never the OpenWOP one.
 */
import { demoMode } from './demoMode.js';
import { SYSTEM_SITE_ORG } from './systemSite.js';
import { configuredSiteProfile } from './systemSiteConfig.js';

export const OPENWOP_SITE_URL = 'https://openwop.dev';

/** The hero film (openwop.dev-hosted). The `?v=` MUST match the SPA's
 *  `FILM` in `frontend/react/src/features/cms/SectionRenderer.tsx` — the
 *  structured data describes the film the page actually embeds (test-pinned). */
export const HERO_FILM = {
  name: 'OpenWOP: open-source orchestration for multi-agent workflows',
  description: 'An agent is about to pay a supplier invoice. Each step is recorded as it happens, the work pauses for a person to approve the payment, the finished run is rewound and plays again without paying twice, the same steps play out in the same order on a second host, and the agents move to another host while the secrets stay behind. A scripted illustration: no host is contacted.',
  contentUrl: 'https://openwop.dev/assets/video/openwop-intro.mp4?v=2026-10-04.1',
  thumbnailUrl: 'https://openwop.dev/assets/video/openwop-intro-poster.jpg?v=2026-10-04.1',
  duration: 'PT1M34S',
  uploadDate: '2026-10-04',
} as const;

export interface SiteProfile {
  /** og:site_name / Organization + WebSite name. */
  siteName: string;
  organizationSameAs: string[];
  /** Extra JSON-LD for THIS page (home only today). */
  pageBlocks: object[];
}

/** The profile for one page of the system site, or null (every other org, or
 *  a non-demo install) — the caller then renders exactly what it always did. */
export function systemSiteProfile(orgId: string, slug: string, baseUrl: string, description: string): SiteProfile | null {
  if (orgId !== SYSTEM_SITE_ORG) return null;
  const configured = configuredSiteProfile();
  if (configured !== undefined) {
    if (!configured) return null;
    return {
      siteName: configured.siteName,
      organizationSameAs: configured.organizationSameAs,
      pageBlocks: slug === 'home' ? configured.homeJsonLd : [],
    };
  }
  if (!demoMode()) return null;
  const origin = baseUrl.replace(/\/+$/, '');
  const home = slug === 'home';
  return {
    siteName: 'OpenWOP',
    organizationSameAs: [OPENWOP_SITE_URL, 'https://github.com/openwop'],
    pageBlocks: home ? [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'OpenWOP',
        description,
        url: `${origin}/`,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isBasedOn: OPENWOP_SITE_URL,
        about: { '@type': 'Thing', name: 'OpenWOP protocol', url: OPENWOP_SITE_URL },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        ...HERO_FILM,
      },
    ] : [],
  };
}

/** The `/llms.txt` head for the system site: a title + one-paragraph
 *  definition before the docs listing, or null (generic head). */
export function systemSiteLlmsPreamble(orgId: string): { title: string; summary: string; body: string } | null {
  if (orgId !== SYSTEM_SITE_ORG) return null;
  const configured = configuredSiteProfile();
  if (configured !== undefined) return configured?.llms ?? null;
  if (!demoMode()) return null;
  return {
    title: 'OpenWOP reference app',
    summary: 'The reference app for OpenWOP, the open-source protocol for multi-agent workflow orchestration.',
    body: 'Build workflows on a canvas or in chat, watch every step as it runs, pause for a person\'s approval, and rewind a finished run to any step. No sign-up is needed to try it. '
      + `The protocol itself is specified at ${OPENWOP_SITE_URL}; its agent-readable index is ${OPENWOP_SITE_URL}/llms.txt, and ${OPENWOP_SITE_URL}/ai-tools/ covers using OpenWOP from AI coding tools.`,
  };
}
