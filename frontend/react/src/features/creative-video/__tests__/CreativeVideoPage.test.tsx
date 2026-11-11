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
 *
 * /grade-tests w52 — witnessed by sabotage of `CreativeVideoPage.tsx`: the
 * `jobsFailed` branch, `orgsFailed={orgsFailed}`, both arms of the CV-G2
 * clear-on-success guard, the danger tone, the real empty state and the
 * job-read retry. Mocks are `mockReset` per case (clearAllMocks kept queued
 * `…Once` values), fixtures are typed against the client's exported types, and
 * the feature-access mock is the shared `makeFeatureAccess` (ADR 0661 shape).
 * CV-G3's class assertion is an honest ceiling: the tone IS the class.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { GenerateResult, OrgRef, VideoJob, VideoModels } from '../creativeVideoClient.js';

const { listOrgs, listVideoJobs, listVideoModels, generateVideo, textToVideo, getVideoJob, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listVideoJobs: vi.fn(), listVideoModels: vi.fn(), generateVideo: vi.fn(), textToVideo: vi.fn(), getVideoJob: vi.fn(),
  useFeatureAccess: vi.fn(),
}));

vi.mock('../creativeVideoClient.js', async (orig) => ({
  ...(await orig<typeof import('../creativeVideoClient.js')>()),
  listOrgs, listVideoJobs, listVideoModels, generateVideo, textToVideo, getVideoJob,
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

const ORG: OrgRef[] = [{ orgId: 'o1', name: 'Acme' }];
/** The host's table as `GET …/video-models` serves it (ADR 1051 D2/D5). */
const MODELS: VideoModels = {
  defaultModel: 'gen4.5',
  likenessConsentTextVersion: 'cv-likeness-2026-11',
  models: [
    { id: 'gen4.5', label: 'Gen-4.5', endpoints: ['t2v', 'i2v'], ratios: { t2v: ['1280:720', '720:1280'] }, duration: { min: 2, max: 10 }, defaultDurationSec: 5 },
    { id: 'veo3.1', label: 'Veo 3.1', endpoints: ['t2v', 'i2v'], ratios: { t2v: ['1280:720', '1080:1920'] }, duration: { oneOf: [4, 6, 8] }, defaultDurationSec: 6 },
  ],
};

const mount = async (): Promise<void> => {
  render(<CreativeVideoPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  for (const m of [listOrgs, listVideoJobs, listVideoModels, generateVideo, textToVideo, getVideoJob, useFeatureAccess]) m.mockReset();
  useFeatureAccess.mockReturnValue(makeFeatureAccess());
  listOrgs.mockResolvedValue(ORG);
  listVideoJobs.mockResolvedValue([]);
  listVideoModels.mockResolvedValue(MODELS);
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
    expect(listVideoJobs).toHaveBeenCalledWith('o1');
    expect(screen.queryByText('No videos yet')).toBeNull();
    expect(screen.getByText('Could not load your videos')).toBeTruthy();
    // The failure is actionable, not a dead end.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
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
    fireEvent.click(screen.getByLabelText(/consent to use their likeness/));
    const refused: GenerateResult = { status: 'failed', jobId: 'j1', error: 'over budget' };
    generateVideo.mockResolvedValue(refused);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate video' })); });
    expect((screen.getByLabelText(/Script/) as HTMLTextAreaElement).value).toBe('Our Q3 story, carefully written.');
  });

  it('clears it on an outcome that consumed the input', async () => {
    await mount();
    typeScript('Consumed.');
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
    fireEvent.click(screen.getByLabelText(/consent to use their likeness/));
    const accepted: GenerateResult = { status: 'pending', jobId: 'j1' };
    generateVideo.mockResolvedValue(accepted);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate video' })); });
    expect((screen.getByLabelText(/Script/) as HTMLTextAreaElement).value).toBe('');
  });
});

describe('CV-G3 — a failure reason is not secondary text', () => {
  it('renders a failed job’s reason in the danger tone', async () => {
    const jobs: VideoJob[] = [
      { jobId: 'j1', status: 'failed', provider: 'heygen', error: 'no_connection', createdAt: '2026-07-25T10:00:00Z' },
      { jobId: 'j2', status: 'completed', provider: 'heygen', assetId: 'a1', createdAt: '2026-07-25T10:00:00Z' },
    ];
    listVideoJobs.mockResolvedValue(jobs);
    await mount();
    // ADR 1051 D11 — the row reads the translated reason, never the raw code.
    expect(screen.queryByText('no_connection')).toBeNull();
    const reason = screen.getByText(/No video provider is connected/);
    expect(reason.className).toContain('u-text-danger');
    expect(reason.className).not.toContain('u-text-muted');
  });
});

describe('ADR 1051 D5 — nothing is sent without the consent tick', () => {
  const fill = (): void => {
    fireEvent.change(screen.getByLabelText(/Script/), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
  };

  it('the avatar submit stays disabled until the person ticks the sentence, and then carries it with the served version', async () => {
    await mount();
    fill();
    const submit = screen.getByRole('button', { name: 'Generate video' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/consent to use their likeness/));
    expect(submit.disabled).toBe(false);
    generateVideo.mockResolvedValue({ status: 'pending', jobId: 'j1' } satisfies GenerateResult);
    await act(async () => { fireEvent.click(submit); });
    expect(generateVideo).toHaveBeenCalledWith('o1', { script: 'Hello', avatarId: 'av_1', consent: { attested: true, textVersion: 'cv-likeness-2026-11' } });
  });

  it('when the video options cannot be read, the page says so and nothing can be submitted', async () => {
    listVideoModels.mockRejectedValue(new Error('500'));
    await mount();
    fill();
    fireEvent.click(screen.getByLabelText(/consent to use their likeness/));
    expect(screen.getByText(/Could not load the video options/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Generate video' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ADR 1051 D2 — text-to-video offers only what the host lists', () => {
  it('the model, ratio and length come from the table, and the request carries them', async () => {
    useFeatureAccess.mockReturnValue(makeFeatureAccess());
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Text-to-video' })); });
    fireEvent.change(screen.getByLabelText(/Prompt/), { target: { value: 'A lighthouse' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'veo3.1' } });
    const ratio = screen.getByLabelText('Ratio') as HTMLSelectElement;
    expect([...ratio.options].map((o) => o.value)).toEqual(['1280:720', '1080:1920']);
    const length = screen.getByLabelText('Length') as HTMLSelectElement;
    expect([...length.options].map((o) => o.value)).toEqual(['4', '6', '8']);
    expect(length.value, 'the model\'s default').toBe('6');
    textToVideo.mockResolvedValue({ status: 'pending', jobId: 'j2' } satisfies GenerateResult);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate video' })); });
    expect(textToVideo).toHaveBeenCalledWith('o1', { prompt: 'A lighthouse', model: 'veo3.1', ratio: '1280:720', durationSec: 6 });
  });
});

describe('grade-ux fixes (ADR 1051)', () => {
  it('CV83UX-1 — changing the avatar or the voice takes the consent tick back', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText(/Script/), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
    const tick = screen.getByLabelText(/consent to use their likeness/) as HTMLInputElement;
    fireEvent.click(tick);
    expect(tick.checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_2' } });
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    fireEvent.change(screen.getByLabelText(/Voice/), { target: { value: 'v_9' } });
    expect(tick.checked).toBe(false);
  });

  it('CV83UX-2 — a disabled Generate says why, and points at the reason', async () => {
    await mount();
    const submit = screen.getByRole('button', { name: 'Generate video' });
    expect(screen.getByText('Write the script the avatar should say.').id).toBe(submit.getAttribute('aria-describedby'));
    fireEvent.change(screen.getByLabelText(/Script/), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
    expect(screen.getByText('Tick the consent statement for this avatar and voice.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/consent to use their likeness/));
    expect(submit.getAttribute('aria-describedby')).toBeNull();
  });

  it('CV83UX-6 — an unconfirmed submit reads as a warning, not a failure, and the text is cleared', async () => {
    listVideoJobs.mockResolvedValue([{ jobId: 'j1', status: 'failed', provider: 'heygen', error: 'submit_unconfirmed', createdAt: '2026-11-03T10:00:00Z' }] satisfies VideoJob[]);
    await mount();
    const chip = screen.getByText('Unconfirmed');
    expect(chip.className).toContain('chip--warning');
    expect(screen.queryByText('Failed')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Script/), { target: { value: 'Once only' } });
    fireEvent.change(screen.getByLabelText(/Avatar/), { target: { value: 'av_1' } });
    fireEvent.click(screen.getByLabelText(/consent to use their likeness/));
    generateVideo.mockResolvedValue({ status: 'failed', jobId: 'j2', error: 'submit_unconfirmed' } satisfies GenerateResult);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate video' })); });
    expect((screen.getByLabelText(/Script/) as HTMLTextAreaElement).value, 'kept text would invite a second paid submit').toBe('');
  });
});
