/**
 * The `/` picker's Templates group, rendered (the picker-templates ADR).
 *
 * Why this exists: the rules in `lib/slashTemplates.ts` only matter if the
 * picker renders and applies them. This pins the rendered behaviour: the group
 * order (Commands, Workflows, Templates); no templates for a bare `/`; a
 * template pick hands an "open preflight" intent to the composer and inserts
 * nothing; without workflow-write the row is disabled and picking it does
 * nothing; an owned copy shows in Workflows with a "From template" chip in
 * place of its template.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ChainTemplate } from '../../builder/persistence/backendStore.js';
import type { WorkflowMentionEntry } from '../lib/workflowMentions.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }), Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey }));

let owned: WorkflowMentionEntry[] = [];
let catalog: ChainTemplate[] = [];
let canWrite = true;

vi.mock('../lib/workflowMentions.js', async (orig) => ({
  ...(await orig<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
  listWorkflowMentions: () => owned,
  workflowMentionLoadFailed: () => false,
}));
vi.mock('../lib/slashTemplates.js', async (orig) => ({
  ...(await orig<typeof import('../lib/slashTemplates.js')>()),
  refreshChainTemplateCache: vi.fn(async () => true),
  listCachedChainTemplates: () => catalog,
}));
vi.mock('../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../lib/writeAccess.js')>()),
  useScopeWriteAccess: () => canWrite,
}));
// No FeatureAccess provider: the default context (no features on) is enough,
// because these chains name no required features.

import { SlashAutocomplete } from '../SlashAutocomplete.js';

function chain(chainId: string, label: string): ChainTemplate {
  return { chainId, packName: 'pack', label, description: `${label} description` };
}

beforeEach(() => {
  owned = [{ displayName: 'Campaign notes', slug: 'campaign-notes', description: 'd', toolName: 't1', workflowId: 'wf.blank.1' }];
  catalog = [chain('cs.launch', 'Campaign launch'), chain('cs.weekly', 'Campaign weekly report')];
  canWrite = true;
});
afterEach(cleanup);

async function renderPicker(text: string, onTemplateIntent = vi.fn(), onPick = vi.fn()) {
  await act(async () => {
    render(<SlashAutocomplete text={text} onPick={onPick} onDismiss={vi.fn()} onTemplateIntent={onTemplateIntent} />);
  });
  return { onTemplateIntent, onPick };
}

/** The listbox's visible text in DOM order, subheads included. */
function listboxOrder(): string[] {
  const lb = screen.getByRole('listbox');
  return Array.from(lb.children).map((el) => (el.textContent ?? '').trim());
}

describe('slash picker Templates group (the picker-templates ADR)', () => {
  it('a typed query that matches templates adds a Templates group after Workflows, with Browse all', async () => {
    await renderPicker('/campaign');
    const order = listboxOrder();
    const wfAt = order.indexOf('workflowsSection');
    const tplAt = order.indexOf('templatesSection');
    expect(wfAt).toBeGreaterThanOrEqual(0);
    expect(tplAt).toBeGreaterThan(wfAt);
    expect(order.slice(tplAt + 1, tplAt + 4)).toEqual([
      expect.stringContaining('Campaign launch'),
      expect.stringContaining('Campaign weekly report'),
      'templateBrowseAll',
    ]);
  });

  it('a bare `/` shows no templates', async () => {
    await renderPicker('/');
    expect(screen.queryByText('templatesSection')).toBeNull();
    expect(screen.queryByText('Campaign launch')).toBeNull();
    expect(screen.queryByText('templateBrowseAll')).toBeNull();
  });

  it('picking a template hands over an open-preflight intent and inserts nothing', async () => {
    const { onTemplateIntent, onPick } = await renderPicker('/launch');
    fireEvent.click(screen.getByText('Campaign launch'));
    expect(onTemplateIntent).toHaveBeenCalledWith({ kind: 'open-preflight', chainId: 'cs.launch', prefix: '' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Browse all opens the gallery intent', async () => {
    const { onTemplateIntent } = await renderPicker('/campaign');
    fireEvent.click(screen.getByText('templateBrowseAll'));
    expect(onTemplateIntent).toHaveBeenCalledWith({ kind: 'browse-templates', prefix: '' });
  });

  it('without workflow-write the row is disabled, says why, and picking it does nothing', async () => {
    canWrite = false;
    const { onTemplateIntent, onPick } = await renderPicker('/launch');
    const option = screen.getByText('Campaign launch').closest('[role="option"]');
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText('templateAskAdmin').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Campaign launch'));
    // Enter on the highlighted (first, disabled) row: still nothing.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onTemplateIntent).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('an owned copy (fromChainId) replaces the template row, in Workflows, with a From template chip', async () => {
    owned = [...owned, { displayName: 'Q4 push', slug: 'q4-push', description: 'd', toolName: 't2', workflowId: 'wf.copy.cs-launch.1', fromChainId: 'cs.launch' }];
    const { onPick } = await renderPicker('/launch');
    // "Q4 push" does not match "launch" by name; it is listed because it is the
    // caller's copy of the matching template.
    expect(screen.getByText('Q4 push')).toBeTruthy();
    expect(screen.getByText('workflowFromTemplateChip')).toBeTruthy();
    expect(screen.queryByText('Campaign launch')).toBeNull();
    fireEvent.click(screen.getByText('Q4 push'));
    expect(onPick).toHaveBeenCalledWith('/q4-push ');
  });

  it('without onTemplateIntent the picker shows no Templates group (other hosts of the picker)', async () => {
    await act(async () => {
      render(<SlashAutocomplete text="/campaign" onPick={vi.fn()} onDismiss={vi.fn()} />);
    });
    expect(screen.queryByText('templatesSection')).toBeNull();
  });
});
