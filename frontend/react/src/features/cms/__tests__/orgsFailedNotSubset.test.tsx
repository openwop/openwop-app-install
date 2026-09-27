/**
 * The org-edge defect in its most dangerous form: **the failure was invisible by
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
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listOrgs, listPages } = vi.hoisted(() => ({ listOrgs: vi.fn(), listPages: vi.fn() }));
const { getSiteConfig } = vi.hoisted(() => ({ getSiteConfig: vi.fn() }));
vi.mock('../cmsClient.js', async (orig) => ({
  ...(await orig<typeof import('../cmsClient.js')>()),
  listOrgs, listPages,
}));
// `getSiteConfig` lives in the SITE feature, not cms — mocking it on cmsClient
// would silently do nothing and the site-admin arm would test the wrong path.
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
    expect(document.body.textContent).toContain('Front page');
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
  });

  it('NON-ADMIN: does not sit on the skeleton either', async () => {
    // `orgs` stays null on failure now, so the loading branch would spin forever
    // if the failed branch were not tested above it.
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
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
    expect(document.body.textContent).not.toContain('this picker may be incomplete');
  });
});
