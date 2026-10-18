/**
 * ADR 0768 follow-up B4 — the Workbench "Sources" tab.
 * Pins: sources come only from what turns RECORDED (citations on assistant
 * turns, attachments on user turns), a URL counts once per turn, the tab
 * appears only when there is something to list, and the receipt offers the
 * tab only inside a shell that has a Workbench.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }));
vi.mock('../../artifacts/ArtifactWorkbench.js', () => ({ ArtifactWorkbench: () => null }));
vi.mock('../../workflowProgress/WorkflowProgressPanel.js', () => ({ WorkflowProgressPanel: () => <div data-testid="run-panel" /> }));
vi.mock('../../lib/toolEffects.js', () => ({ useToolEffects: () => new Map() }));

import { collectSources } from '../sources.js';
import { Workbench } from '../Workbench.js';
import { TurnReceipt } from '../../TurnReceipt.js';
import { WorkbenchActionsContext } from '../workbenchActions.js';
import type { ChatMessage, Citation, ContentPart } from '../../types.js';

afterEach(cleanup);

const asst = (id: string, urls: string[]): ChatMessage => ({
  id, role: 'assistant', content: 'x', createdAt: 't',
  meta: { provider: 'p', model: 'm', citations: urls.map((url): Citation => ({ url, title: `T ${url}` })) },
});
const user = (id: string, parts: ContentPart[]): ChatMessage => ({ id, role: 'user', content: parts, createdAt: 't' });

describe('collectSources', () => {
  it('de-duplicates web sources by URL and counts each turn once', () => {
    const s = collectSources([
      asst('a', ['https://a.test/1', 'https://a.test/1', 'https://b.test/']),
      asst('b', ['https://a.test/1']),
    ]);
    expect(s.web.map((w) => [w.url, w.turns])).toEqual([['https://a.test/1', 2], ['https://b.test/', 1]]);
  });

  it('lists files and images the user sent, not text or audio, and not assistant content', () => {
    const s = collectSources([
      user('u', [{ type: 'text', text: 'hi' }, { type: 'file', mimeType: 'application/pdf', name: 'msa.pdf', url: '/f/1' }, { type: 'image', mimeType: 'image/png', alt: 'redlines' }, { type: 'audio', mimeType: 'audio/webm', dataBase64: 'x' }]),
      user('u2', [{ type: 'file', mimeType: 'application/pdf', name: 'msa.pdf', url: '/f/1' }]),
    ]);
    expect(s.files).toEqual([{ name: 'msa.pdf', mimeType: 'application/pdf', url: '/f/1' }, { name: 'redlines', mimeType: 'image/png' }]);
    // An assistant turn whose content carries a file part (a generated asset) is
    // NOT something the user sent.
    const generated: ChatMessage = { id: 'a2', role: 'assistant', createdAt: 't', content: [{ type: 'file', mimeType: 'application/pdf', name: 'gen.pdf', url: '/f/9' }] };
    expect(collectSources([generated]).files).toEqual([]);
  });

  it('its key changes only when the list changes', () => {
    const a = collectSources([asst('a', ['https://a.test/'])]);
    expect(collectSources([asst('a', ['https://a.test/'])]).key).toBe(a.key);
    expect(collectSources([asst('a', ['https://a.test/']), asst('b', ['https://a.test/'])]).key).not.toBe(a.key);
  });
});

const runProps = { workflowRunMessages: [], focusedMessageId: null, onFocus: vi.fn(), onCancel: vi.fn(async () => undefined) };
const wb = (tab: 'run' | 'sources', sources = collectSources([])) => render(
  <Workbench tab={tab} onSelectTab={vi.fn()} onClose={vi.fn()} isMobile={false} runProps={runProps} artifact={null} onCloseArtifact={vi.fn()} sources={sources} />,
);

describe('Workbench Sources tab', () => {
  it('appears only when there is something to list, with a count badge', () => {
    wb('run');
    expect(screen.queryByRole('tab', { name: /workbenchTabSources/ })).toBeNull();
    cleanup();
    wb('run', collectSources([asst('a', ['https://a.test/'])]));
    const tab = screen.getByRole('tab', { name: /workbenchTabSources/ });
    expect(tab.querySelector('.workbench-tab-badge')?.textContent).toBe('1');
  });

  it('renders the list, with each web source as an external link', () => {
    wb('sources', collectSources([asst('a', ['https://a.test/x'])]));
    const link = screen.getByRole('link', { name: 'T https://a.test/x' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('says so plainly when selected with nothing to show', () => {
    wb('sources');
    expect(screen.getByText('sourcesEmpty')).toBeTruthy();
  });
});

describe('receipt → Sources', () => {
  const turn = asst('a', ['https://a.test/']);
  it('offers the Workbench only inside a shell that has one', () => {
    render(<TurnReceipt message={turn} />);
    fireEvent.click(screen.getByRole('button'));
    // Positive control: the receipt IS expanded (its meta line shows), so the
    // absence below is the gate, not a collapsed receipt.
    expect(screen.getByRole('button', { name: 'receiptHide' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('p/m')).toBeTruthy();
    expect(screen.queryByText('receiptOpenSources')).toBeNull();
  });
  it('opens the Sources tab from the expanded receipt', () => {
    const openSources = vi.fn();
    render(<WorkbenchActionsContext.Provider value={{ openSources }}><TurnReceipt message={turn} /></WorkbenchActionsContext.Provider>);
    fireEvent.click(screen.getAllByRole('button')[0]!);
    fireEvent.click(screen.getByText('receiptOpenSources'));
    expect(openSources).toHaveBeenCalledOnce();
  });
});
