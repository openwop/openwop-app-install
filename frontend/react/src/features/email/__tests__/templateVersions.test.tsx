/**
 * ADR 0905 D1 — the template editor's version history + the stale-save conflict.
 *
 * Sabotage-witnessed: dropping `expectedVersion` from the save reds the first case;
 * catching the conflict as a generic toast (no notice) reds it too; enabling Restore
 * while dirty reds the third.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EmailTemplate } from '../emailClient.js';

class TemplateVersionConflictError extends Error {
  constructor(readonly currentVersion: number | undefined) { super('version_conflict'); }
}
const client = vi.hoisted(() => ({
  listOrgs: vi.fn(), getTemplate: vi.fn(), updateTemplate: vi.fn(), deleteTemplate: vi.fn(), previewMarkdown: vi.fn(),
  listTemplateVersions: vi.fn(), diffTemplateVersion: vi.fn(), restoreTemplateVersion: vi.fn(),
  TemplateVersionConflictError: undefined as unknown,
}));
client.TemplateVersionConflictError = TemplateVersionConflictError;
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', () => client);
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

const { EmailTemplateDetailPage } = await import('../EmailTemplateDetailPage.js');

const tpl = (over: Partial<EmailTemplate> = {}): EmailTemplate => ({
  templateId: 'tpl1', orgId: 'o1', name: 'Welcome', subject: 'Hi', body: 'Hello', format: 'text', version: 2,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
});
const versions = [
  { templateId: 'tpl1', version: 2, subject: 'Hi', body: 'Hello', createdBy: 'u1', createdAt: '2026-01-02T00:00:00.000Z' },
  { templateId: 'tpl1', version: 1, subject: 'Old', body: 'Hello there', createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' },
];
const renderDetail = () => render(
  <MemoryRouter initialEntries={['/email/templates/tpl1?org=o1']}>
    <Routes><Route path="/email/templates/:templateId" element={<EmailTemplateDetailPage />} /></Routes>
  </MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  client.getTemplate.mockResolvedValue(tpl());
  client.listTemplateVersions.mockResolvedValue(versions);
});

describe('ADR 0905 D1 — template versions in the editor', () => {
  it('a save sends the loaded version; a version conflict shows the reload notice, not a toast', async () => {
    client.updateTemplate.mockRejectedValue(new TemplateVersionConflictError(3));
    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Hello'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(client.updateTemplate).toHaveBeenCalled());
    expect(client.updateTemplate.mock.calls[0]![2]).toMatchObject({ body: 'Edited', expectedVersion: 2 });
    expect(await screen.findByText('Someone else saved this template.')).toBeTruthy();
    client.getTemplate.mockResolvedValue(tpl({ version: 3, body: 'Theirs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(await screen.findByDisplayValue('Theirs')).toBeTruthy();
  });

  it('lists versions; compare renders the server diff; restore calls the route with the current version', async () => {
    client.diffTemplateVersion.mockResolvedValue({
      from: 1, to: 2, subject: { from: 'Old', to: 'Hi', changed: true },
      body: { format: 'text', added: 1, removed: 1, lines: [{ op: 'remove', text: 'Hello there' }, { op: 'add', text: 'Hello' }] },
    });
    client.restoreTemplateVersion.mockResolvedValue(tpl({ version: 3, subject: 'Old', body: 'Hello there' }));
    renderDetail();
    expect(await screen.findByText(/Version 1 ·/)).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Compare version 1 with the current version' }));
    expect(await screen.findByText(/Subject: “Old” → “Hi”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(client.restoreTemplateVersion).toHaveBeenCalledWith('o1', 'tpl1', 1, 2));
    expect(await screen.findByDisplayValue('Hello there')).toBeTruthy();
  });

  it('Restore is disabled while the editor holds unsaved edits', async () => {
    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Hello'), { target: { value: 'dirty' } });
    const restore = await screen.findByRole('button', { name: 'Restore version 1' });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
  });
});
