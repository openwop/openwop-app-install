/**
 * UX_UPGRADE-creative-video CV-G1..G4.
 *
 * CV-G1: both reads wrote `[]` on failure, so an unreachable server rendered
 * "No workspace yet — create one" and "No videos yet": two confident claims
 * about state we had failed to read, one of them an INSTRUCTION. HG-4 then moved
 * the ORG half onto the shared `ui/useOrgSelection` + `ui/OrgSelectionState`
 * seam — the hand-rolled version still set `setOrgs([])` beside its flag, and
 * only reached its zero-org branch BECAUSE of that sentinel.
 *
 * CV-G2: a `failed` generation cleared the script. 429 (over budget), 409 (no
 * connection) and 502 (provider error) are exactly the recoverable cases — and
 * wiping the input made them unrecoverable.
 *
 * CV-G3: a failed job's reason sat in the same muted grey as its timestamp.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listVideoJobs, generateVideo, textToVideo, getVideoJob, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listVideoJobs: vi.fn(), generateVideo: vi.fn(), textToVideo: vi.fn(), getVideoJob: vi.fn(),
  useFeatureAccess: vi.fn(),
}));

vi.mock('../creativeVideoClient.js', async (orig) => ({
  ...(await orig<typeof import('../creativeVideoClient.js')>()),
  listOrgs, listVideoJobs, generateVideo, textToVideo, getVideoJob,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

import { CreativeVideoPage } from '../CreativeVideoPage.js';

const ON = { status: 'on', enabled: true, isBeta: false, variant: null, entitled: true, locked: false, loading: false };
const ORG = [{ orgId: 'o1', name: 'Acme' }];

const mount = async (): Promise<void> => {
  render(<CreativeVideoPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(ON);
  listOrgs.mockResolvedValue(ORG);
  listVideoJobs.mockResolvedValue([]);
});

describe('CV-G1 — a failed read is not an empty result', () => {
  it('a failed organization read does not claim there is no organization', async () => {
    listOrgs.mockRejectedValue(new Error('503 upstream'));
    await mount();
    // HG-4: the noun, the copy and the branch order are `ui/OrgSelectionState`'s
    // now, so these are the SHARED strings — a page that re-grew its own would be
    // red here, and so would one that reverted to "workspace".
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.getByText('Could not load your organizations')).toBeTruthy();
    expect(screen.getByText(
      'Nothing was created or changed. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The generate form is inside the org-state chain: `orgId` is '' so a submit
    // could not write anywhere, and the job read never starts.
    expect(screen.queryByRole('button', { name: 'Generate video' })).toBeNull();
    expect(listVideoJobs).not.toHaveBeenCalled();
  });

  it('the retry re-runs the organization read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503 upstream')).mockResolvedValue(ORG);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate video' })).toBeTruthy();
  });

  it('read SUCCEEDS with []: the real zero-organization state STILL says so', async () => {
    // The fix must not cost the real empty state its message.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(screen.getByText('No organizations')).toBeTruthy();
    expect(screen.getByText('AI videos are generated and stored in an organization.')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(listVideoJobs).not.toHaveBeenCalled();
  });

  it('a failed job read does not claim there are no videos', async () => {
    listVideoJobs.mockRejectedValue(new Error('500 boom'));
    await mount();
    expect(screen.queryByText('No videos yet')).toBeNull();
    expect(screen.getByText('Could not load your videos')).toBeTruthy();
  });

  it('a genuinely empty job list STILL says so', async () => {
    await mount();
    expect(screen.getByText('No videos yet')).toBeTruthy();
    expect(screen.queryByText('Could not load your videos')).toBeNull();
  });

  it('retrying a failed job read clears the failed state on success', async () => {
    listVideoJobs.mockRejectedValueOnce(new Error('500 boom')).mockResolvedValueOnce([]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.getByText('No videos yet')).toBeTruthy();
    expect(screen.queryByText('Could not load your videos')).toBeNull();
  });
});

describe('CV-G2 — a failed generation keeps the input', () => {
  const typeScript = (text: string): HTMLTextAreaElement => {
    const el = screen.getByLabelText(/Script/) as HTMLTextAreaElement;
    fireEvent.change(el, { target: { value: text } });
    return el;
  };

  it('keeps the script when the provider refuses', async () => {
    await mount();
    typeScript('Our Q3 story, carefully written.');
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
    generateVideo.mockResolvedValue({ status: 'failed', jobId: 'j1', error: 'over budget' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate video' })); });
    expect((screen.getByLabelText(/Script/) as HTMLTextAreaElement).value).toBe('Our Q3 story, carefully written.');
  });

  it('clears it on an outcome that consumed the input', async () => {
    await mount();
    typeScript('Consumed.');
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
    generateVideo.mockResolvedValue({ status: 'pending', jobId: 'j1' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate video' })); });
    expect((screen.getByLabelText(/Script/) as HTMLTextAreaElement).value).toBe('');
  });
});

describe('CV-G3 — a failure reason is not secondary text', () => {
  it('renders a failed job’s reason in the danger tone', async () => {
    listVideoJobs.mockResolvedValue([
      { jobId: 'j1', status: 'failed', provider: 'heygen', error: 'avatar not found', createdAt: '2026-07-25T10:00:00Z' },
      { jobId: 'j2', status: 'completed', provider: 'heygen', assetId: 'a1', createdAt: '2026-07-25T10:00:00Z' },
    ]);
    await mount();
    const reason = screen.getByText('avatar not found');
    expect(reason.className).toContain('u-text-danger');
    expect(reason.className).not.toContain('u-text-muted');
  });
});
