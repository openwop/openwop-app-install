/**
 * ADR 1109 P2 — the inbox a customer reads (#5793 part 1).
 *
 *  - D5: an adopter's own notification type can need action. `ACTION_NEEDED_TYPES`
 *    was a fixed pair, so `casavoga.check-in` never reached "Action needed".
 *  - D6: "You're all caught up" sat above a tab reading "Action needed 11",
 *    because the line counted roster approvals and waiting agents only.
 *  - D2 (mirrored): one reader for what a request says.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../agents/approvalsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals: vi.fn(async () => []),
  listApprovalsByKind: vi.fn(async () => []),
}));
vi.mock('../../agents/agentViewModel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews: vi.fn(async () => []),
}));
vi.mock('../../chat/reviews/ReviewHandoff.js', () => ({ ReviewHandoff: () => null }));

import { MemoryRouter } from 'react-router-dom';
import { NeedsYouInbox } from '../NeedsYouInbox.js';
import { SubjectChip } from '../SubjectChip.js';
import { isActionNeeded, subjectProjectId, type Notification } from '../types.js';
import { canonicalInboxTabFor, inboxTabShows } from '../notificationDeepLink.js';
import { requestWords } from '../../interrupts/requestWords.js';
import { featureActionNeededTypes } from '../../features/registry.js';

afterEach(() => cleanup());

const note = (type: string): Notification => ({
  notificationId: `n-${type}`, type, priority: 'normal', status: 'unread',
  title: 'Check-in due', message: 'Kitchen remodel', createdAt: '2026-11-11T00:00:00Z',
});

describe('D5 — features declare their action-needed types', () => {
  const adopter = new Set(['casavoga.check-in']);

  it('a declared type needs action; an undeclared one does not', () => {
    expect(isActionNeeded(note('casavoga.check-in'), adopter)).toBe(true);
    expect(isActionNeeded(note('casavoga.check-in'))).toBe(false);
    expect(isActionNeeded(note('agent.escalation'), adopter)).toBe(false);
  });

  it('the host\'s own two types need action with or without declarations', () => {
    expect(isActionNeeded(note('workflow.input_needed'))).toBe(true);
    expect(isActionNeeded(note('openwop-app.workflow.approval-needed'), adopter)).toBe(true);
  });

  it('a deep link to a declared type lands on, and is shown by, "Action needed"', () => {
    expect(canonicalInboxTabFor(note('casavoga.check-in'), adopter)).toBe('action-needed');
    expect(inboxTabShows('action-needed', note('casavoga.check-in'), adopter)).toBe(true);
    expect(canonicalInboxTabFor(note('casavoga.check-in'))).toBe('all');
  });

  it('the registry reads the composed features (a set, never the host pair twice)', () => {
    const types = featureActionNeededTypes();
    expect(types).toBeInstanceOf(Set);
    expect(types.has('workflow.input_needed')).toBe(false);
  });
});

describe('D6 — "all caught up" counts workflow requests', () => {
  it('says all clear when nothing waits anywhere', async () => {
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    expect(await screen.findByText(/all caught up/)).toBeTruthy();
  });

  it('never says all clear while the page holds workflow requests', async () => {
    const { container } = render(<MemoryRouter><NeedsYouInbox workflowRequests={11} /></MemoryRouter>);
    // While loading it renders its full card; once the (empty) loads settle with
    // requests waiting, it renders nothing and the list below carries them. An
    // empty container is therefore the settled state, not the initial one.
    expect(container.firstChild).not.toBeNull();
    await vi.waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText(/all caught up/)).toBeNull();
  });
});

describe('D2 — one reader for what a request says (SPA mirror)', () => {
  it('reads the title apart, the text from prompt, then description, then summary', () => {
    expect(requestWords({ title: 'T', prompt: 'P', description: 'D', summary: 'S' })).toEqual({ title: 'T', text: 'P' });
    expect(requestWords({ description: 'D', summary: 'S' })).toEqual({ text: 'D' });
    expect(requestWords({ summary: 'S' })).toEqual({ text: 'S' });
    expect(requestWords({ title: ' ', prompt: '' })).toEqual({});
    expect(requestWords(null)).toEqual({});
  });
});

describe('D4 — a request names its project, by the reader\'s own list', () => {
  const withSubject = (subject: unknown): Notification => ({ ...note('workflow.input_needed'), metadata: { kind: 'approval', subject } });

  it('reads only a host-shaped project subject', () => {
    expect(subjectProjectId(withSubject({ kind: 'project', id: 'p-kitchen' }))).toBe('p-kitchen');
    expect(subjectProjectId(withSubject({ kind: 'user', id: 'u-1' }))).toBeUndefined();
    expect(subjectProjectId(withSubject({ kind: 'project', id: '' }))).toBeUndefined();
    expect(subjectProjectId(note('workflow.input_needed'))).toBeUndefined();
  });

  it('links a project the reader can see, by its name', () => {
    render(<MemoryRouter><SubjectChip projectId="p-kitchen" projectNames={new Map([['p-kitchen', 'Kitchen remodel']])} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Kitchen remodel' }).getAttribute('href')).toBe('/projects/p-kitchen');
  });

  it('a project the reader cannot see stays "A project", with no link', () => {
    render(<MemoryRouter><SubjectChip projectId="p-private" projectNames={new Map()} /></MemoryRouter>);
    expect(screen.getByText('A project')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
