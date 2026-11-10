/**
 * CMS-SCOPE-EMPTY-1 (ADR 0828 correction, 2026-11-07): the CMS language panel's
 * read boundary. An empty org issues no request; a late callback from an old
 * org (settings success, settings failure, translator-grants failure) never
 * notifies the parent or paints the new org; a current failure is disclosed.
 *
 * Guards (CmsLanguageSettings.tsx load effect): the empty-org early return, the
 * `live` flag on the settings then/catch and the grants catch, and the effect
 * cleanup that clears it. Double guard, recorded: for an empty org the render
 * also returns the loading line, so the DOM checks in case 2 are held twice;
 * its parent-notification and call-count checks are what witness `live`.
 *
 * Sabotage-witnessed (grade-tests w97, r1): dropping the empty-org guard, the
 * `live` check on settings success or failure, the effect cleanup, or the
 * current-failure disclosure each turn a case red. Added in r2 (the r1 probe
 * was vacuous): dropping the `live` check on the grants failure.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { CmsLocaleGrant, LanguageSettings } from '../cmsClient.js';
import type { OrgMember } from '../../../client/accessClient.js';

const api = vi.hoisted(() => ({
  settings: vi.fn<(orgId: string) => Promise<LanguageSettings>>(),
  grants: vi.fn<(orgId: string) => Promise<CmsLocaleGrant[]>>(),
  members: vi.fn<(orgId: string) => Promise<OrgMember[]>>(),
}));
vi.mock('../cmsClient.js', async original => ({ ...(await original<typeof import('../cmsClient.js')>()), getLanguageSettings: api.settings, listLocaleGrants: api.grants }));
vi.mock('../../../client/accessClient.js', async original => ({ ...(await original<typeof import('../../../client/accessClient.js')>()), listMembers: api.members }));
import { CmsLanguageSettings } from '../CmsLanguageSettings.js';

function held<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred resolver was not initialized'); };
  let reject: (error: Error) => void = () => { throw new Error('Deferred rejection was not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settings = (locale: string): LanguageSettings => ({ baseLocale: locale, supportedLocales: [], autoTranslateOnPublish: false });
beforeEach(() => {
  api.settings.mockReset().mockResolvedValue(settings('en'));
  api.grants.mockReset().mockResolvedValue([]);
  api.members.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

it('does not request settings, grants or members for an empty org, then reads exactly the selected org', async () => {
  const changed = vi.fn();
  const view = render(<CmsLanguageSettings orgId="" onChange={changed} />);
  await act(async () => {});
  expect(api.settings).not.toHaveBeenCalled();
  expect(api.grants).not.toHaveBeenCalled();
  expect(api.members).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
  view.rerender(<CmsLanguageSettings orgId="org-current" onChange={changed} />);
  await waitFor(() => expect(changed).toHaveBeenCalledWith(settings('en')));
  expect(api.settings).toHaveBeenCalledExactlyOnceWith('org-current');
  expect(api.grants).toHaveBeenCalledExactlyOnceWith('org-current');
  expect(api.members).toHaveBeenCalledExactlyOnceWith('org-current');
});

it('clearing the scope invalidates a pending old-org read and never calls the parent with it', async () => {
  const pending = held<LanguageSettings>();
  api.settings.mockReturnValueOnce(pending.promise);
  const changed = vi.fn();
  const view = render(<CmsLanguageSettings orgId="org-old" onChange={changed} />);
  expect(api.settings).toHaveBeenCalledExactlyOnceWith('org-old');
  view.rerender(<CmsLanguageSettings orgId="" onChange={changed} />);
  await act(async () => pending.resolve(settings('fr')));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByText('fr')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(api.settings).toHaveBeenCalledTimes(1);
  expect(api.grants).toHaveBeenCalledTimes(1);
  expect(api.members).toHaveBeenCalledTimes(1);
});

it('an older success cannot replace the current org catalog or parent notification', async () => {
  const old = held<LanguageSettings>();
  const oldGrants = held<CmsLocaleGrant[]>();
  api.settings.mockImplementation(org => org === 'org-old' ? old.promise : Promise.resolve(settings('en')));
  api.grants.mockImplementation(org => org === 'org-old' ? oldGrants.promise : Promise.resolve([]));
  const changed = vi.fn();
  const view = render(<CmsLanguageSettings orgId="org-old" onChange={changed} />);
  view.rerender(<CmsLanguageSettings orgId="org-current" onChange={changed} />);
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(settings('en')));
  await act(async () => old.resolve(settings('fr')));
  await act(async () => oldGrants.reject(new Error('old grants unavailable')));
  expect(changed).toHaveBeenCalledExactlyOnceWith(settings('en'));
  expect(screen.queryByText('fr')).toBeNull();
  // The old org's grants failure is not this org's: no grants-failure notice.
  expect(screen.queryByText(/Could not load translator grants/)).toBeNull();
  expect(screen.queryByText(/old grants unavailable/)).toBeNull();
  expect(api.settings.mock.calls.map(call => call[0])).toEqual(['org-old', 'org-current']);
  expect(api.grants.mock.calls.map(call => call[0])).toEqual(['org-old', 'org-current']);
});

it('a late old-org failure stays hidden but a current valid-org failure is still disclosed', async () => {
  const old = held<LanguageSettings>();
  api.settings.mockImplementation(org => org === 'org-old' ? old.promise : Promise.reject(new Error('current settings unavailable')));
  const changed = vi.fn();
  const view = render(<CmsLanguageSettings orgId="org-old" onChange={changed} />);
  view.rerender(<CmsLanguageSettings orgId="org-current" onChange={changed} />);
  expect(await screen.findByText('Could not load language settings: current settings unavailable')).toBeTruthy();
  await act(async () => old.reject(new Error('old settings unavailable')));
  expect(screen.getByText('Could not load language settings: current settings unavailable')).toBeTruthy();
  expect(screen.queryByText(/old settings unavailable/)).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
