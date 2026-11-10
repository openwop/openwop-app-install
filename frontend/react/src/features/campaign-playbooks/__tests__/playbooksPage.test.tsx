/** ADR 0959 recovery: a superseded preview cannot authorize another selection;
 * partial writes must be shown as requiring attention, never as all-success.
 * Sabotage: drop the preview ticket or `invalidatePlan` → the old preview enables
 * the request; drop the `failed` check in the ring or the client → "applied" shows. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from 'i18next';
const h = vi.hoisted(() => ({ listPlaybooks: vi.fn(), listVersions: vi.fn(), listInstallations: vi.fn(), listRollouts: vi.fn(), planRollout: vi.fn(), requestRollout: vi.fn(), applyRing: vi.fn(), listClients: vi.fn() }));
vi.mock('../playbooksClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));
vi.mock('../../campaign-ops/campaignOpsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listClients: h.listClients }));
import { PlaybooksPage } from '../PlaybooksPage.js';
import { config } from '../../../client/config.js';
import type { Installation, PlaybookSummary, PlaybookVersion, Rollout, TargetPlan } from '../playbooksClient.js';

const copy = (key: string, options: Record<string, unknown> = {}) => t(`campaign-playbooks:${key}`, options);
const plan: TargetPlan = { orgId: 'client-a', fromVersion: '1.0.0', class: 'clean', drift: 'none', chainDiff: { added: [], removed: [], changed: ['draft'] }, configDiff: { changes: [], truncated: 0 }, conflicts: [], contentDiff: [] };
const AT = '2026-10-20T00:00:00Z';
const SUMMARY: PlaybookSummary = { playbookId: 'method', title: 'Method', latestVersion: '3.0.0', publishedAt: AT, changelog: '' };
const VERSIONS: PlaybookVersion[] = ['3.0.0', '2.0.0', '1.0.0'].map((version) => ({ playbookId: 'method', version, title: 'Method', changelog: '', publishedAt: AT, contentHash: `hash-${version}` }));
const INSTALL: Installation = { orgId: 'client-a', playbookId: 'method', pinnedVersion: '1.0.0', drift: 'none', ring: 'general', history: [] };
const ROLLOUT: Rollout = { rolloutId: 'rollout', playbookId: 'method', approvalId: 'appr-1', toVersion: '3.0.0', createdAt: AT, status: 'approved', plan: [plan], mode: 'rings', rings: [{ name: 'general', orgIds: ['client-a'], soakHours: 0 }], targets: { 'client-a': { status: 'pending' } } };

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.listPlaybooks.mockResolvedValue([SUMMARY]);
  h.listVersions.mockResolvedValue(VERSIONS);
  h.listInstallations.mockResolvedValue([INSTALL]);
  h.listRollouts.mockResolvedValue([]);
  h.listClients.mockResolvedValue({ clients: [{ orgId: 'client-a', displayName: 'Client A' }] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PlaybooksPage recovery', () => {
  it('ignores an old preview after the target version changes and requires a new preview', async () => {
    let finish!: (value: TargetPlan[]) => void;
    h.planRollout.mockImplementationOnce(() => new Promise<TargetPlan[]>((resolve) => { finish = resolve; })).mockResolvedValueOnce([plan]);
    render(<PlaybooksPage />);
    fireEvent.click(await screen.findByRole('button', { name: copy('previewPlan') }));
    fireEvent.change(screen.getByLabelText(copy('toVersionLabel')), { target: { value: '2.0.0' } });
    await act(async () => { finish([plan]); });
    expect((screen.getByRole('button', { name: copy('requestApproval') }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.requestRollout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: copy('previewPlan') }));
    await vi.waitFor(() => expect((screen.getByRole('button', { name: copy('requestApproval') }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: copy('requestApproval') }));
    expect(h.requestRollout).toHaveBeenCalledWith('method', '2.0.0', { rings: true });
  });

  it('reports failed ring targets without announcing that the ring was upgraded', async () => {
    h.listRollouts.mockResolvedValue([ROLLOUT]);
    h.applyRing.mockResolvedValue({ applied: [], manual: [], failed: [{ orgId: 'client-a', reason: 'content_partial' }] });
    render(<PlaybooksPage />);
    fireEvent.click(await screen.findByRole('button', { name: copy('applyRing') }));
    expect(await screen.findByText(copy('ringNeedsAttention', { clients: 'Client A' }))).toBeTruthy();
    expect(screen.queryByText(copy('ringApplied'))).toBeNull();
  });

  it('the real API client refuses an all-success result when content needs review', async () => {
    const api = await vi.importActual<typeof import('../playbooksClient.js')>('../playbooksClient.js');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ content: { failed: [{ message: 'A human edited this page; review it first.' }] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.applyTarget('rollout', 'client-a', false)).rejects.toMatchObject({ message: 'A human edited this page; review it first.', reason: 'content_partial' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${config.baseUrl}/host/openwop-app/campaign-playbooks/rollouts/rollout/targets/client-a/apply`);
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
  });
});
