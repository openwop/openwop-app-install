/**
 * ADR 0905 D1 — the template editor's version history + the stale-save conflict.
 *
 * Sabotage-witnessed (w55g1-tv-* round 1, w55g1-tv-*-r2 round 2): dropping
 * `expectedVersion` from the save reds the first case; catching the conflict as a
 * generic toast (no notice), or as the notice AND a toast, reds it too; a reload
 * that keeps the stale draft reds it; dropping the diff body or restoring on the
 * wrong base reds the second; enabling Restore while dirty, or disabling it always,
 * reds the third.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as Email from '../emailClient.js';
import type { EmailTemplate, EmailTemplateVersion, EmailTemplateVersionDiff } from '../emailClient.js';
import type * as Toast from '../../../ui/toast.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

// Typed against the real client; the REAL TemplateVersionConflictError rides through the spread.
const listOrgs = vi.fn<typeof Email.listOrgs>();
const getTemplate = vi.fn<typeof Email.getTemplate>();
const updateTemplate = vi.fn<typeof Email.updateTemplate>();
const deleteTemplate = vi.fn<typeof Email.deleteTemplate>();
const previewMarkdown = vi.fn<typeof Email.previewMarkdown>();
const listTemplateVersions = vi.fn<typeof Email.listTemplateVersions>();
const diffTemplateVersion = vi.fn<typeof Email.diffTemplateVersion>();
const restoreTemplateVersion = vi.fn<typeof Email.restoreTemplateVersion>();
vi.mock('../emailClient.js', async (orig) => ({
  ...(await orig<typeof Email>()),
  listOrgs: (...a: Parameters<typeof Email.listOrgs>) => listOrgs(...a),
  getTemplate: (...a: Parameters<typeof Email.getTemplate>) => getTemplate(...a),
  updateTemplate: (...a: Parameters<typeof Email.updateTemplate>) => updateTemplate(...a),
  deleteTemplate: (...a: Parameters<typeof Email.deleteTemplate>) => deleteTemplate(...a),
  previewMarkdown: (...a: Parameters<typeof Email.previewMarkdown>) => previewMarkdown(...a),
  listTemplateVersions: (...a: Parameters<typeof Email.listTemplateVersions>) => listTemplateVersions(...a),
  diffTemplateVersion: (...a: Parameters<typeof Email.diffTemplateVersion>) => diffTemplateVersion(...a),
  restoreTemplateVersion: (...a: Parameters<typeof Email.restoreTemplateVersion>) => restoreTemplateVersion(...a),
}));
const toastError = vi.fn<typeof Toast.toast.error>();
const toastSuccess = vi.fn<typeof Toast.toast.success>();
vi.mock('../../../ui/toast.js', async (orig) => {
  const real = await orig<typeof Toast>();
  return {
    ...real,
    toast: {
      ...real.toast,
      error: (...a: Parameters<typeof Toast.toast.error>) => toastError(...a),
      success: (...a: Parameters<typeof Toast.toast.success>) => toastSuccess(...a),
    },
  };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

const { TemplateVersionConflictError } = await import('../emailClient.js');
const { EmailTemplateDetailPage } = await import('../EmailTemplateDetailPage.js');

const tpl = (over: Partial<EmailTemplate> = {}): EmailTemplate => ({
  templateId: 'tpl1', orgId: 'o1', name: 'Welcome', subject: 'Hi', body: 'Hello', format: 'text', version: 2,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
});
const versions: EmailTemplateVersion[] = [
  { templateId: 'tpl1', version: 2, subject: 'Hi', body: 'Hello', createdBy: 'u1', createdAt: '2026-01-02T00:00:00.000Z' },
  { templateId: 'tpl1', version: 1, subject: 'Old', body: 'Hello there', createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' },
];
const diff: EmailTemplateVersionDiff = {
  from: 1, to: 2, subject: { from: 'Old', to: 'Hi', changed: true },
  body: { format: 'text', added: 1, removed: 1, lines: [{ op: 'remove', text: 'Hello there' }, { op: 'add', text: 'Hello' }] },
};
const renderDetail = () => render(
  <MemoryRouter initialEntries={['/email/templates/tpl1?org=o1']}>
    <Routes><Route path="/email/templates/:templateId" element={<EmailTemplateDetailPage />} /></Routes>
  </MemoryRouter>);

beforeEach(() => {
  for (const m of [listOrgs, getTemplate, updateTemplate, deleteTemplate, previewMarkdown, listTemplateVersions, diffTemplateVersion, restoreTemplateVersion, toastError, toastSuccess]) m.mockReset();
  getTemplate.mockResolvedValue(tpl());
  listTemplateVersions.mockResolvedValue(versions);
});

describe('ADR 0905 D1 — template versions in the editor', () => {
  it('a save sends the loaded version; a version conflict shows the reload notice, not a toast', async () => {
    updateTemplate.mockRejectedValue(new TemplateVersionConflictError(3));
    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Hello'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1));
    expect(updateTemplate).toHaveBeenCalledWith('o1', 'tpl1', expect.objectContaining({ body: 'Edited', expectedVersion: 2 }));
    expect(await screen.findByText('Someone else saved this template.')).toBeTruthy();
    // The notice IS the feedback: no error toast beside it.
    expect(toastError).not.toHaveBeenCalled();
    getTemplate.mockResolvedValue(tpl({ version: 3, body: 'Theirs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(await screen.findByDisplayValue('Theirs')).toBeTruthy();
    expect(screen.queryByText('Someone else saved this template.')).toBeNull();
  });

  it('lists versions; compare renders the server diff; restore calls the route with the current version', async () => {
    diffTemplateVersion.mockResolvedValue(diff);
    restoreTemplateVersion.mockResolvedValue(tpl({ version: 3, subject: 'Old', body: 'Hello there' }));
    renderDetail();
    expect(await screen.findByText(/Version 1 ·/)).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Compare version 1 with the current version' }));
    expect(await screen.findByText(/Subject: “Old” → “Hi”/)).toBeTruthy();
    expect(diffTemplateVersion).toHaveBeenCalledWith('o1', 'tpl1', 1);
    // The body diff renders too: the removed line and the added line, each marked by its op.
    const region = screen.getByRole('region', { name: 'Compare version 1 with the current version' });
    const removed = region.querySelectorAll('.artifact-diff__line--remove');
    const added = region.querySelectorAll('.artifact-diff__line--add');
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]!.textContent).toContain('Hello there');
    expect(added[0]!.textContent).toContain('Hello');
    expect(added[0]!.textContent).not.toContain('Hello there');
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(restoreTemplateVersion).toHaveBeenCalledWith('o1', 'tpl1', 1, 2));
    expect(await screen.findByDisplayValue('Hello there')).toBeTruthy();
  });

  it('Restore is disabled while the editor holds unsaved edits', async () => {
    renderDetail();
    // Positive control: with a clean editor Restore is enabled and carries no dirty hint.
    const before = await screen.findByRole('button', { name: 'Restore version 1' });
    expect(before).toHaveProperty('disabled', false);
    expect(before.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('Save or discard your edits before restoring a version.')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Hello'), { target: { value: 'dirty' } });
    const restore = await screen.findByRole('button', { name: 'Restore version 1' });
    await waitFor(() => expect(restore).toHaveProperty('disabled', true));
    const hint = screen.getByText('Save or discard your edits before restoring a version.');
    expect(restore.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.id).not.toBe('');
  });
});
