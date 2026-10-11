/**
 * HG-4 / ANN-UX-2 (#2968, #2974) — the org-edge defect in its most dangerous form: **the failure was invisible by
 * construction.**
 *
 * `pickerOrgs` prepends a SYNTHETIC Front-page scope for a site admin. So with
 * `.catch(() => setOrgs([]))`, a failed workspace read left the picker
 * non-empty, an org auto-selected, and the page rendered completely — while
 * every real workspace was missing from it. No spinner, no empty state, no
 * error. An admin sees a working CMS scoped to the public front page and has no
 * way to know their workspaces' pages were never listed.
 *
 * The page ALREADY HAD the correct guard — `if (orgId || orgs === null) return`
 * exists precisely so the default-selection waits for the probe to settle. The
 * catch is what defeated it, by making a failure look settled. Keeping `orgs`
 * null on failure restores the guard for free; the disclosure is what had to be
 * added.
 *
 * Both arms matter more than usual here: the Front-page scope stays USABLE on a
 * failed read, because blocking a superadmin out of the public homepage editor
 * would be a bigger lie than the one being fixed.
 *
 * Sabotage-witnessed (/grade-tests w17): hiding the orgsFailed Notice reds the
 * site-admin disclosure; passing the raw `orgsFailed` to OrgSelectionState (the
 * admin lock-out) reds the Front-page case; dropping it for everyone reds the
 * non-admin case; feeding `null` for an empty list reds the zero-org case; a
 * notice on any settled read reds the healthy case.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listOrgs, listPages } = vi.hoisted(() => ({ listOrgs: vi.fn(), listPages: vi.fn() }));
const { getSiteConfig } = vi.hoisted(() => ({ getSiteConfig: vi.fn() }));
vi.mock('../cmsClient.js', async (orig) => ({
  ...(await orig<typeof import('../cmsClient.js')>()),
  listOrgs, listPages,
  // Once an org is selected the page makes its per-org reads. They are not this
  // file's claim; unmocked they were live network calls (the file's old ADR 0661
  // allowlist entry). Answered with the "nothing configured" shapes.
  getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
  listSharedSections: vi.fn(async () => []),
  listLocaleGrants: vi.fn(async () => []),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listMembers: vi.fn(async () => []),
  getEffectiveAccess: vi.fn(() => new Promise<never>(() => {})), // "unknown" — the hook's failed-read state
}));
vi.mock('../../media/mediaClient.js', async (orig) => ({
  ...(await orig<typeof import('../../media/mediaClient.js')>()),
  listAssets: vi.fn(async () => []),
}));
// `getSiteConfig` lives in the SITE feature, not cms — mocking it on cmsClient
// would silently do nothing and the site-admin arm would test the wrong path.
// The Page tab reads and writes the page's search and social record.
vi.mock('../../publishing/publishingClient.js', () => ({ getSeo: vi.fn(async () => null), putSeo: vi.fn(async (_o: string, _p: string, seo: unknown) => seo) }));
vi.mock('../../site/siteConfigClient.js', async (orig) => ({
  ...(await orig<typeof import('../../site/siteConfigClient.js')>()),
  getSiteConfig,
}));

import { CmsPage } from '../CmsPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };

const mount = async (): Promise<void> => {
  render(<MemoryRouter><CmsPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  getSiteConfig.mockRejectedValue(new Error('403')); // not a site admin by default
  listPages.mockResolvedValue([]);
});

describe('a failed workspace read is never a silent subset', () => {
  it('SITE ADMIN: discloses it, instead of silently showing only the Front-page scope', async () => {
    // The dangerous path — the page works, so nothing else would ever tell them.
    getSiteConfig.mockResolvedValue({ enabled: true });
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('this picker may be incomplete');
  });

  it('SITE ADMIN: the Front-page scope stays usable — the fix does not lock them out', async () => {
    // The failure mode of this fix: a superadmin blocked from the public homepage
    // editor because an unrelated list failed.
    getSiteConfig.mockResolvedValue({ enabled: true });
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    // The scope is offered in the picker AND the editor is not hidden behind the
    // failed-organizations card (the picker option alone renders in both states).
    expect(screen.getByRole('option', { name: 'Front page (public site)' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });

  it('NON-ADMIN: does not claim "No organizations — create one first"', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    // HG-4 — the SHARED copy (`ui/OrgSelectionState`). This page's own title
    // already said "organizations" while its body and the body's second clause
    // said "workspace list"; the card is now one voice, and the site-admin
    // Notice above keeps the page-specific "this picker may be incomplete".
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(
      'The page list was never requested. This is a failed read, not an empty organization list.',
    );
    expect(document.body.textContent).not.toContain('Pages belong to an organization.');
    // …and does not sit on the skeleton either: `orgs` stays null on failure, so
    // the loading branch would spin forever if the failed branch did not win.
    expect(document.querySelector('.skeleton')).toBeNull();
  });

  it('a tenant that genuinely has no organizations still gets the instruction', async () => {
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('Pages belong to an organization.');
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });

  it('a healthy read raises no warning', async () => {
    await mount();
    // Settled, not merely early: the real organization is in the picker.
    expect(screen.getByRole('option', { name: 'Acme' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('this picker may be incomplete');
  });
});
