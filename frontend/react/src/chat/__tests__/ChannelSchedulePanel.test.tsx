/**
 * ADR 0202 D3 + OQ-4 / SCHED-1 — the channel "Schedule a recurring post" picker.
 * Pins: the frequency + time + weekday controls COMPOSE the right cron on create;
 * the empty-agents state shows guidance instead of a form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

type Client = typeof import('../../client/channelsClient.js');
const { list, create, setEnabled, del } = vi.hoisted(() => ({
  list: vi.fn<Client['listChannelScheduledPosts']>(),
  create: vi.fn<Client['createChannelScheduledPost']>(),
  setEnabled: vi.fn<Client['setChannelScheduledPostEnabled']>(),
  del: vi.fn<Client['deleteChannelScheduledPost']>(),
}));
vi.mock('../../client/channelsClient.js', () => ({
  listChannelScheduledPosts: list,
  createChannelScheduledPost: create,
  setChannelScheduledPostEnabled: setEnabled,
  deleteChannelScheduledPost: del,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../i18n/format.js', () => ({ formatWeekday: (d: number) => `wd${d}`, formatTime: () => '9:00 AM', formatDateTime: () => 'soon' }));

import { ChannelSchedulePanel } from '../conversations/ChannelSchedulePanel.js';
import type { ChannelScheduledPost } from '../../client/channelsClient.js';

const CREATED: ChannelScheduledPost = { chatId: 'c1', agentId: 'a1', prompt: 'p', cronExpr: '0 9 * * *', conversationId: 'conv-1', enabled: true };

beforeEach(() => {
  cleanup();
  list.mockReset(); create.mockReset(); setEnabled.mockReset(); del.mockReset();
  list.mockResolvedValue([]);
  create.mockResolvedValue(CREATED);
});

describe('ChannelSchedulePanel — cron composition (SCHED-1)', () => {
  it('composes a WEEKLY cron (minute/hour/day) from the picker and calls create', async () => {
    render(<ChannelSchedulePanel channelId="ch1" agents={[{ agentId: 'a1', displayName: 'Iris' }]} />);
    await waitFor(() => expect(list).toHaveBeenCalledWith('ch1'));

    fireEvent.change(screen.getByLabelText('schedAgentLabel'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('schedPromptLabel'), { target: { value: 'Standup summary' } });
    fireEvent.change(screen.getByLabelText('schedCadenceLabel'), { target: { value: 'weekly' } });
    fireEvent.change(await screen.findByLabelText('schedDayLabel'), { target: { value: '3' } }); // Wednesday
    fireEvent.change(screen.getByLabelText('schedTimeLabel'), { target: { value: '14:30' } });
    fireEvent.click(screen.getByText('schedCreateCta'));

    await waitFor(() => expect(create).toHaveBeenCalled());
    const [channelId, body] = create.mock.calls[0]!;
    expect(channelId).toBe('ch1');
    expect(body).toMatchObject({ agentId: 'a1', prompt: 'Standup summary', cronExpr: '30 14 * * 3' });
  });

  it('DAILY at the default time composes `0 9 * * *`', async () => {
    render(<ChannelSchedulePanel channelId="ch1" agents={[{ agentId: 'a1', displayName: 'Iris' }]} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('schedAgentLabel'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('schedPromptLabel'), { target: { value: 'Digest' } });
    fireEvent.click(screen.getByText('schedCreateCta'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [, body] = create.mock.calls[0]!;
    expect(body.cronExpr).toBe('0 9 * * *');
  });

  it('with NO channel-member agents, shows guidance and no create form', async () => {
    render(<ChannelSchedulePanel channelId="ch1" agents={[]} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.getByText('schedNoAgents')).toBeTruthy();
    expect(screen.queryByLabelText('schedCadenceLabel')).toBeNull();
  });
});
