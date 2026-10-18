/**
 * ADR 0785 D5 follow-on — the Claude Code section of the chat rail.
 *
 * Rows come from ONE terminals read + ONE devices read (never per row); only live
 * sessions show, newest first; a row whose session an open tab already shows
 * FOCUSES that tab; any other row opens a new tab PRE-SEEDED in `tabStore`, so
 * `ClaudeCodeTerminalTab` reattaches at mount instead of showing the picker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { TerminalSession, DeviceView } from '../claudeCodeClient.js';

const api = vi.hoisted(() => ({
  listTerminals: vi.fn<() => Promise<TerminalSession[]>>(),
  listDevices: vi.fn<() => Promise<DeviceView[]>>(),
}));
vi.mock('../claudeCodeClient.js', () => ({ listTerminals: api.listTerminals, listDevices: api.listDevices }));

import { ClaudeCodeRailSection, liveSessions } from '../ClaudeCodeRailSection.js';
import { tabStore } from '../terminalTabStore.js';

const term = (sessionId: string, createdAt: string, extra: Partial<TerminalSession> = {}): TerminalSession =>
  ({ sessionId, deviceId: 'dev-1', status: 'running', title: `Title ${sessionId}`, createdAt, ...extra });
const device: DeviceView = {
  deviceId: 'dev-1', tenantId: 't', subject: 'u', label: 'Laptop', platform: 'darwin', createdAt: '2026-10-01T00:00:00Z',
  consentVersion: '1', consentHash: 'h', status: 'active', online: true,
};
// An OFFLINE second device — with every device online, a constant "online"
// label could not be told from the real mapping.
const desktop: DeviceView = { ...device, deviceId: 'dev-2', label: 'Desktop', online: false };

beforeEach(() => {
  localStorage.clear();
  api.listTerminals.mockReset();
  api.listDevices.mockReset();
  api.listDevices.mockResolvedValue([device, desktop]);
});
afterEach(() => cleanup());

function renderSection(props: { openTabIds?: string[]; activeTabId?: string | null } = {}) {
  const focusTab = vi.fn();
  const openNewTab = vi.fn();
  render(<ClaudeCodeRailSection openTabIds={props.openTabIds ?? []} activeTabId={props.activeTabId ?? null} focusTab={focusTab} openNewTab={openNewTab} />);
  return { focusTab, openNewTab };
}

describe('liveSessions', () => {
  it('drops exited sessions, sorts newest first, and bounds the list', () => {
    const all = [
      term('old', '2026-10-01T00:00:00Z'),
      term('gone', '2026-10-03T00:00:00Z', { status: 'exited' }),
      term('new', '2026-10-02T00:00:00Z', { status: 'opening' }),
    ];
    expect(liveSessions(all).map((s) => s.sessionId)).toEqual(['new', 'old']);
    const many = Array.from({ length: 15 }, (_, i) => term(`s${i}`, `2026-10-01T00:00:${String(i).padStart(2, '0')}Z`));
    // The NEWEST ten survive, newest first (s14 … s5), not merely ten of them.
    expect(liveSessions(many).map((s) => s.sessionId)).toEqual(['s14', 's13', 's12', 's11', 's10', 's9', 's8', 's7', 's6', 's5']);
  });
});

describe('ClaudeCodeRailSection', () => {
  it('lists live sessions from the client with device + online hint, in one read each', async () => {
    api.listTerminals.mockResolvedValue([
      term('a', '2026-10-01T00:00:00Z'),
      term('b', '2026-10-02T00:00:00Z', { deviceId: 'dev-2' }),
      term('x', '2026-10-03T00:00:00Z', { status: 'exited' }),
    ]);
    renderSection();
    const titles = await screen.findAllByText(/^Title /);
    expect(titles.map((el) => el.textContent)).toEqual(['Title b', 'Title a']);
    // Each row carries ITS device's state: b is on the offline Desktop, a on the online Laptop.
    const rowB = screen.getByRole('button', { name: /Title b/ });
    const rowA = screen.getByRole('button', { name: /Title a/ });
    expect(within(rowB).getByRole('img').getAttribute('aria-label')).toBe('Device offline');
    expect(within(rowA).getByRole('img').getAttribute('aria-label')).toBe('Device online');
    expect(within(rowB).getByText(/^Desktop · /)).toBeTruthy();
    expect(within(rowA).getByText(/^Laptop · /)).toBeTruthy();
    expect(api.listTerminals).toHaveBeenCalledTimes(1);
    expect(api.listDevices).toHaveBeenCalledTimes(1);
  });

  it('clicking a session an open tab already shows FOCUSES that tab', async () => {
    api.listTerminals.mockResolvedValue([term('a', '2026-10-01T00:00:00Z')]);
    tabStore.set('claude-code-tab1', 'a');
    const { focusTab, openNewTab } = renderSection({ openTabIds: ['claude-code-tab1'] });
    fireEvent.click(await screen.findByRole('button', { name: /Title a/ }));
    expect(focusTab).toHaveBeenCalledWith('claude-code-tab1');
    expect(openNewTab).not.toHaveBeenCalled();
  });

  it('clicking another session opens a new tab with tabStore PRE-SEEDED (reattach, not the picker)', async () => {
    api.listTerminals.mockResolvedValue([term('a', '2026-10-01T00:00:00Z'), term('b', '2026-10-02T00:00:00Z')]);
    tabStore.set('claude-code-tab1', 'a');
    const { focusTab, openNewTab } = renderSection({ openTabIds: ['claude-code-tab1'] });
    fireEvent.click(await screen.findByRole('button', { name: /Title b/ }));
    expect(focusTab).not.toHaveBeenCalled();
    expect(openNewTab).toHaveBeenCalledTimes(1);
    const opts = openNewTab.mock.calls[0]![0] as { seed: (id: string) => void; title: string };
    expect(opts.title).toBe('Title b');
    opts.seed('claude-code-new');
    // What ClaudeCodeTerminalTab reads at mount to reattach.
    expect(tabStore.get('claude-code-new')).toBe('b');
  });

  it('falls back to "Claude Code · <device>" when a session has no title', async () => {
    api.listTerminals.mockResolvedValue([term('a', '2026-10-01T00:00:00Z', { title: '' })]);
    renderSection();
    expect(await screen.findByText('Claude Code · Laptop')).toBeTruthy();
  });

  it('empty: one quiet line + "Start one" opens a fresh tab', async () => {
    api.listTerminals.mockResolvedValue([term('x', '2026-10-01T00:00:00Z', { status: 'exited' })]);
    const { openNewTab } = renderSection();
    expect(await screen.findByText('No sessions running.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Start one/ }));
    expect(openNewTab).toHaveBeenCalledWith();
  });

  it('a failed read renders quietly with a retry, and a devices failure still shows sessions', async () => {
    api.listTerminals.mockRejectedValueOnce(new Error('boom'));
    renderSection();
    expect(await screen.findByText(/Sessions unavailable\./)).toBeTruthy();
    api.listTerminals.mockResolvedValue([term('a', '2026-10-01T00:00:00Z')]);
    api.listDevices.mockRejectedValue(new Error('nope'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    expect(screen.getByText(/^Unknown device · /)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Device (online|offline)/ })).toBeNull();
  });
});
