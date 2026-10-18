/**
 * CH2UX-1/2/5 (ADR 0879) — the channel surface derives WHY a viewer cannot post
 * from the server's flags, and turns the new refusals into copy a person can act on.
 */
import { describe, expect, it } from 'vitest';
import { channelWriteState } from '../useChannelRoster.js';
import { channelErrorCopy } from '../channelErrors.js';
import { ChannelRequestError, type ChannelDetail } from '../../../client/channelsClient.js';

const detail = (over: Partial<ChannelDetail>, channel: Partial<NonNullable<ChannelDetail['channel']>> = {}): ChannelDetail => ({
  conversationId: 'c1',
  channel: { name: 'general', visibility: 'public', ...channel },
  ...over,
});

describe('channelWriteState', () => {
  it('claims nothing before the detail resolves', () => {
    expect(channelWriteState(null)).toEqual({ readOnlyReason: null, viewerCanWrite: null });
  });
  it('a viewer who may post can write', () => {
    expect(channelWriteState(detail({ viewerCanPost: true }))).toEqual({ readOnlyReason: null, viewerCanWrite: true });
  });
  it('an open channel that still refuses the post means a read-only ROLE', () => {
    expect(channelWriteState(detail({ viewerCanPost: false }))).toEqual({ readOnlyReason: 'role', viewerCanWrite: false });
  });
  it('an announcement channel is its own reason and does not claim the role', () => {
    expect(channelWriteState(detail({ viewerCanPost: false }, { postingPolicy: 'managers' }))).toEqual({ readOnlyReason: 'managers', viewerCanWrite: null });
  });
  it('an archived channel says archived, not managers-only', () => {
    expect(channelWriteState(detail({ viewerCanPost: false, viewerCanManage: true }, { archived: true, postingPolicy: 'managers' })))
      .toEqual({ readOnlyReason: 'archived', viewerCanWrite: true });
  });
});

describe('channelErrorCopy', () => {
  const t = (k: string): string => k;
  it('maps the D1 role refusal', () => {
    expect(channelErrorCopy(new ChannelRequestError(403, 'forbidden_scope', 'Missing required scope: workspace:write', { requiredScope: 'workspace:write' }), t, 'chat:x'))
      .toBe('chat:channelWriteForbidden');
  });
  it('maps the D8 announcement refusal', () => {
    expect(channelErrorCopy(new ChannelRequestError(403, 'forbidden', 'Only…', { channelId: 'c1', code: 'channel_managers_only' }), t, 'chat:x'))
      .toBe('chat:channelReadOnlyComposer');
  });
  it('maps the D4 not-in-workspace refusal', () => {
    expect(channelErrorCopy(new ChannelRequestError(404, 'not_found', 'That person…', { userId: 'u9' }), t, 'chat:x'))
      .toBe('chat:channelMemberNotInWorkspace');
  });
  it('keeps the fallback for anything else, including a channel 404', () => {
    expect(channelErrorCopy(new ChannelRequestError(404, 'not_found', 'Channel not found.', { channelId: 'c1' }), t, 'chat:x')).toBe('chat:x');
    expect(channelErrorCopy(new Error('network'), t, 'chat:x')).toBe('chat:x');
  });
});
