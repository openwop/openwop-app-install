/**
 * Marketing + legal page set (ADR 0391 (c)) — the standard public-site pages a
 * deployment ships so the openwop-app core can serve myndhyve.ai's public site:
 * 8 marketing pages (about/careers/press/contact/community/support/changelog/
 * roadmap) + a 16-page legal suite + the trust-center umbrella page (ADR 0416).
 *
 * Modeled on {@link ensureFeaturesPage}: host-global system-site pages (the
 * reserved `host:site`/`host-site` org no real principal can hold), created as
 * real `cmsService` pages — NOT a parallel page system. Two deliberate
 * departures from the home/features seeders:
 *   - **DRAFT, not published.** This is the operator's own voice + legal
 *     exposure, so seeds land in `draft` and an admin reviews + publishes them
 *     through the editorial gate (ADR 0009). We NEVER transition them here.
 *   - **Legal bodies are counsel-review placeholders.** Each legal page's
 *     richText body STARTS with an explicit `[PLACEHOLDER — …]` banner + purely
 *     structural headings — never fabricated binding legal text (the operator
 *     supplies real copy after counsel review).
 *
 * Idempotent via deterministic `page:host-site-<slug>` ids (the `createPage`
 * fixed-id convergence): a re-seed creates nothing new. `clear()` is host-global
 * + non-destructive per-tenant, exactly like the home/features seeders.
 */
import { createLogger } from '../observability/logger.js';
import { createPage, getPage, type Section } from '../features/cms/cmsService.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';

const log = createLogger('host.marketingLegalPages');

const SYSTEM_ACTOR = 'system';
/** The banner every legal body opens with — the operator MUST replace it (and
 *  the structural stubs beneath) with counsel-reviewed text before publishing. */
const PLACEHOLDER = '[PLACEHOLDER — review by counsel before publishing]';

interface PageSpec { slug: string; title: string; sections: Section[] }

/** A marketing page: a hero + a richText "starter" body the operator edits. */
function marketing(slug: string, title: string, subheading: string, body: string): PageSpec {
  return {
    slug,
    title,
    sections: [
      { sectionId: 'm-hero', type: 'hero', data: { heading: title, subheading } },
      { sectionId: 'm-body', type: 'richText', data: { heading: title, text: body } },
    ],
  };
}

/** A legal page: a hero for chrome + a richText body that STARTS with the
 *  counsel placeholder banner and lays out structural headings only. */
function legal(slug: string, title: string): PageSpec {
  const body = [
    PLACEHOLDER,
    '',
    `This page is a structural starting point for the ${title}. It contains no binding legal language — replace every section below with text reviewed by your legal counsel before publishing.`,
    '',
    '**1. Overview**',
    '',
    `Describe the purpose and scope of this ${title}.`,
    '',
    '**2. Scope**',
    '',
    'State who and what this document applies to.',
    '',
    '**3. Your rights and obligations**',
    '',
    'Summarize the commitments each party makes.',
    '',
    '**4. Changes to this document**',
    '',
    'Explain how updates are communicated and when they take effect.',
    '',
    '**5. Contact**',
    '',
    'Provide the contact for questions about this document.',
  ].join('\n');
  return {
    slug,
    title,
    sections: [
      { sectionId: 'l-hero', type: 'hero', data: { heading: title, subheading: PLACEHOLDER } },
      { sectionId: 'l-body', type: 'richText', data: { heading: title, text: body } },
    ],
  };
}

// NOTE (ADR 0486 follow-up): `about`, `roadmap`, `changelog`, `support` are NOT
// placeholders here — they ship with real, PUBLISHED copy from
// `marketingContentPages.ts`, which OWNS those `page:host-site-*` ids. Keeping them
// out of this DRAFT set avoids two seeders fighting over the same page. What
// remains genuinely needs OPERATOR specifics (careers/roles, press kit, contact
// address, community links), so it stays a review-and-publish draft.
const MARKETING_PAGES: PageSpec[] = [
  marketing('careers', 'Careers', 'Build the future of work with us.', 'Describe your culture, how you work, and the roles you are hiring for. Link open positions here.'),
  marketing('press', 'Press', 'News, media resources, and brand assets.', 'Share recent announcements, media coverage, and a downloadable press kit (logos, screenshots, boilerplate).'),
  marketing('contact', 'Contact', 'Get in touch.', 'List the best ways to reach your team — sales, support, partnerships — and set expectations for response times.'),
  marketing('community', 'Community', 'Connect with other builders.', 'Point visitors to your community spaces — forum, chat, events — and the guidelines for taking part.'),
];

const LEGAL_PAGES: PageSpec[] = [
  legal('privacy', 'Privacy Policy'),
  legal('terms', 'Terms of Service'),
  legal('dpa', 'Data Processing Addendum'),
  legal('aup', 'Acceptable Use Policy'),
  legal('cookies', 'Cookie Policy'),
  legal('ai-addendum', 'AI Addendum'),
  legal('api-terms', 'API Terms'),
  legal('marketplace-terms', 'Marketplace Terms'),
  legal('dmca', 'DMCA Policy'),
  legal('subprocessors', 'Subprocessors'),
  legal('security', 'Security'),
  legal('sla', 'Service Level Agreement'),
  legal('vulnerability-disclosure', 'Vulnerability Disclosure Policy'),
  legal('accessibility', 'Accessibility Statement'),
  legal('support-terms', 'Support Terms'),
  legal('rbac-policy', 'Access Control Policy'),
];

/** The trust-center umbrella page (ADR 0416 P1) — a posture-honest overview
 *  that LINKS the existing security/subprocessors/legal pages rather than
 *  duplicating them. Capability claims below are static-true of this codebase
 *  (they ship in every deployment); anything deployment-specific (posture mode,
 *  uptime, certifications) is an explicit operator placeholder — the seeder
 *  NEVER fabricates a compliance claim. DRAFT like the legal suite: the
 *  operator reviews + publishes through the editorial gate. */
const TRUST_PAGE: PageSpec = {
  slug: 'trust',
  title: 'Trust Center',
  sections: [
    { sectionId: 't-hero', type: 'hero', data: { heading: 'Trust Center', subheading: 'How this platform protects your data — and how to verify it.' } },
    {
      sectionId: 't-security', type: 'richText', data: {
        heading: 'Platform security capabilities',
        text: [
          'Every deployment of this platform ships with:',
          '',
          '- **Multi-factor authentication** (TOTP) with operator-managed enforcement, a hardened secrets vault, and audited break-glass access.',
          '- **Enterprise single sign-on** — SAML 2.0 authentication and SCIM provisioning.',
          '- **A tamper-evident audit trail** — every administrative and governance action is recorded on a per-tenant hash chain whose integrity can be verified and exported.',
          '- **Bring-your-own-key credential handling** — provider credentials are resolved host-side and are never exposed to models, logs, or API responses.',
          '- **Tenant isolation** — every record is tenant-scoped and every access path enforces membership.',
          '- **Governed AI spend** — per-tenant budgets, policy controls, and a capability firewall over agent tool use.',
          '',
          `${PLACEHOLDER} Describe your deployment's authentication posture, hosting region, and any certifications here — state only what your deployment actually provides.`,
        ].join('\n'),
      },
    },
    {
      sectionId: 't-audit', type: 'richText', data: {
        heading: 'Your audit trail is yours',
        text: 'Tenant administrators can export their audit log (CSV or JSON Lines) together with a cryptographic integrity proof, so records can be verified independently of this platform.',
      },
    },
    {
      sectionId: 't-links', type: 'richText', data: {
        heading: 'Policies and disclosures',
        text: [
          '- [Security](/p/security)',
          '- [Subprocessors](/p/subprocessors)',
          '- [Privacy Policy](/p/privacy)',
          '- [Data Processing Addendum](/p/dpa)',
          '- [Vulnerability Disclosure Policy](/p/vulnerability-disclosure)',
          '- [Service Level Agreement](/p/sla)',
          '',
          `${PLACEHOLDER} Add your responsible-disclosure contact (e.g. security@your-domain) and confirm each linked page has been reviewed and published.`,
        ].join('\n'),
      },
    },
  ],
};

const ALL_PAGES: PageSpec[] = [...MARKETING_PAGES, ...LEGAL_PAGES, TRUST_PAGE];

const pageIdFor = (slug: string): string => `page:host-site-${slug}`;

/** Run-once-per-process guard (mirrors systemSite/featuresPage): dedupes
 *  concurrent callers within an instance. A cross-instance first-boot race is
 *  benign — the fixed page ids converge (no duplicate rows). */
let ensuring: Promise<{ created: number }> | null = null;

async function doEnsure(): Promise<{ created: number }> {
  // The reserved system-site org must exist first (idempotent; shared owner).
  await ensureSystemSite();
  let created = 0;
  for (const spec of ALL_PAGES) {
    const pageId = pageIdFor(spec.slug);
    if (await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId)) continue; // idempotent
    await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId,
      title: spec.title, slug: spec.slug, sections: spec.sections, createdBy: SYSTEM_ACTOR,
    });
    // Deliberately NOT published — the operator reviews + publishes (ADR 0391 (c)).
    created += 1;
  }
  if (created > 0) log.info('marketing_legal_pages_seeded', { created });
  return { created };
}

/** Ensure the host-global marketing + legal DRAFT pages exist (idempotent).
 *  The guard dedupes CONCURRENT callers only — it clears after completion so a
 *  later call recomputes honestly ({created: 0} once everything exists) instead
 *  of replaying the first run's stale created count into the seeder registry. */
export function ensureMarketingLegalPages(): Promise<{ created: number }> {
  if (!ensuring) {
    ensuring = doEnsure().finally(() => { ensuring = null; });
  }
  return ensuring;
}

/** How many of the deterministic marketing/legal pages are present (drives the
 *  demo-data dashboard count). */
export async function countMarketingLegalPages(): Promise<number> {
  const present = await Promise.all(
    ALL_PAGES.map((spec) => getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageIdFor(spec.slug))),
  );
  return present.filter(Boolean).length;
}

/** Test-only: drop the in-process ensure memo so a fresh store re-seeds. */
export function __resetMarketingLegalEnsure(): void {
  ensuring = null;
}
