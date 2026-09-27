/**
 * ADR 0336 Rec Phase 3 — inbox deep-link derivation (DL-T-1b) + the FE↔BE
 * URL round-trip (DL-C-3). These pin the resolution the `/inbox` page depends
 * on: the emit sites build `/inbox?approval=<encoded>`, and the page must parse
 * that back to the right row AND pick a tab that actually shows it.
 */
import { describe, it, expect } from 'vitest';
import {
  parseInboxDeepLink,
  matchesInboxDeepLink,
  canonicalInboxTabFor,
  inboxTabShows,
} from '../notificationDeepLink.js';
import type { Notification } from '../types.js';

function notif(over: Partial<Notification>): Notification {
  return {
    notificationId: 'ntf_1',
    type: 'system.alert',
    priority: 'normal',
    status: 'unread',
    title: 't',
    message: 'm',
    createdAt: '2026-07-10T00:00:00.000Z',
    ...over,
  };
}

describe('parseInboxDeepLink', () => {
  it('extracts both params', () => {
    expect(parseInboxDeepLink('?notification=ntf_9&approval=apr_3')).toEqual({ notificationId: 'ntf_9', approvalId: 'apr_3' });
  });
  it('defaults each missing param to empty string', () => {
    expect(parseInboxDeepLink('')).toEqual({ notificationId: '', approvalId: '' });
    expect(parseInboxDeepLink('?approval=apr_3')).toEqual({ notificationId: '', approvalId: 'apr_3' });
  });
});

describe('matchesInboxDeepLink', () => {
  it('matches by notificationId exact', () => {
    expect(matchesInboxDeepLink(notif({ notificationId: 'ntf_x' }), { notificationId: 'ntf_x', approvalId: '' })).toBe(true);
    expect(matchesInboxDeepLink(notif({ notificationId: 'ntf_x' }), { notificationId: 'ntf_y', approvalId: '' })).toBe(false);
  });
  it('matches by metadata.approvalId', () => {
    const n = notif({ metadata: { approvalId: 'apr_7' } });
    expect(matchesInboxDeepLink(n, { notificationId: '', approvalId: 'apr_7' })).toBe(true);
    expect(matchesInboxDeepLink(n, { notificationId: '', approvalId: 'apr_8' })).toBe(false);
  });
  it('never matches on an empty param (no bare /inbox false-positive)', () => {
    expect(matchesInboxDeepLink(notif({}), { notificationId: '', approvalId: '' })).toBe(false);
  });
  it('is safe when metadata is absent or approvalId is not a string', () => {
    expect(matchesInboxDeepLink(notif({ metadata: undefined }), { notificationId: '', approvalId: 'apr_7' })).toBe(false);
    expect(matchesInboxDeepLink(notif({ metadata: { approvalId: 42 } }), { notificationId: '', approvalId: '42' })).toBe(false);
  });
});

describe('canonicalInboxTabFor', () => {
  it('routes archived rows to the archived tab', () => {
    expect(canonicalInboxTabFor(notif({ status: 'archived' }))).toBe('archived');
  });
  it('routes an action-needed row to action-needed', () => {
    expect(canonicalInboxTabFor(notif({ type: 'openwop-app.workflow.approval-needed' }))).toBe('action-needed');
  });
  it('routes any other non-archived row to all', () => {
    expect(canonicalInboxTabFor(notif({ type: 'agent.escalation' }))).toBe('all');
    expect(canonicalInboxTabFor(notif({ type: 'workflow.completed' }))).toBe('all');
  });
});

describe('inboxTabShows', () => {
  it('archived rows appear only under the archived tab', () => {
    const n = notif({ status: 'archived' });
    expect(inboxTabShows('archived', n)).toBe(true);
    expect(inboxTabShows('all', n)).toBe(false);
    expect(inboxTabShows('action-needed', n)).toBe(false);
  });
  it('action-needed rows appear under action-needed and all', () => {
    const n = notif({ type: 'openwop-app.workflow.approval-needed' });
    expect(inboxTabShows('action-needed', n)).toBe(true);
    expect(inboxTabShows('all', n)).toBe(true);
    expect(inboxTabShows('archived', n)).toBe(false);
  });
  it('a non-action-needed row (escalation) is hidden on the default action-needed tab', () => {
    const n = notif({ type: 'agent.escalation' });
    expect(inboxTabShows('action-needed', n)).toBe(false); // ← why the auto-tab switch exists
    expect(inboxTabShows('all', n)).toBe(true);
  });
});

describe('FE↔BE round-trip (DL-C-3)', () => {
  // Mirror of the emit sites: escalationNotify.ts / actionApproval.ts build
  // `/inbox?approval=${encodeURIComponent(approvalId)}`.
  const beActionUrl = (approvalId: string): string => `/inbox?approval=${encodeURIComponent(approvalId)}`;

  it('resolves a BE-emitted approval actionUrl back to the emitting notification', () => {
    const approvalId = 'apr_abc-123';
    const url = beActionUrl(approvalId);
    const search = url.slice(url.indexOf('?'));
    const link = parseInboxDeepLink(search);
    expect(link.approvalId).toBe(approvalId); // decoded
    const n = notif({ metadata: { approvalId } });
    expect(matchesInboxDeepLink(n, link)).toBe(true);
  });

  it('survives an approvalId with URL-reserved characters', () => {
    const approvalId = 'apr/with?weird&=chars';
    const url = beActionUrl(approvalId);
    const search = url.slice(url.indexOf('?'));
    const link = parseInboxDeepLink(search);
    expect(link.approvalId).toBe(approvalId);
    expect(matchesInboxDeepLink(notif({ metadata: { approvalId } }), link)).toBe(true);
  });
});
