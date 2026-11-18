/**
 * The chat template overlay's "Add another copy" path (the picker-templates ADR, D3).
 *
 * Why this exists: once a person owns a copy of a template, the `/` picker shows
 * the owned copy in place of the template row. The gallery ("Browse all
 * templates…") is then the only way to a deliberate second copy, so it must say
 * the person already has one, and its preflight must say "Add another copy"
 * rather than offering a plain create. A template with no owned copy keeps the
 * preflight's own label.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ChainTemplate } from '../../builder/persistence/backendStore.js';
import type { WorkflowMentionEntry } from '../lib/workflowMentions.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }), Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey }));

let owned: WorkflowMentionEntry[] = [];
let catalog: ChainTemplate[] = [];

vi.mock('../lib/workflowMentions.js', async (orig) => ({
  ...(await orig<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
  listWorkflowMentions: () => owned,
}));
vi.mock('../lib/slashTemplates.js', async (orig) => ({
  ...(await orig<typeof import('../lib/slashTemplates.js')>()),
  refreshChainTemplateCache: vi.fn(async () => true),
  listCachedChainTemplates: () => catalog,
}));
// The real modal pulls in the builder; this stand-in shows only what the
// overlay hands it.
vi.mock('../../builder/TemplatePreflightModal.js', () => ({
  TemplatePreflightModal: ({ chain, confirmLabel }: { chain: ChainTemplate; confirmLabel?: string }) => (
    <div role="dialog" aria-label={`preflight ${chain.chainId}`}>
      <button type="button">{confirmLabel ?? 'preflightConfirm'}</button>
    </div>
  ),
}));

import { ChatTemplateOverlay } from '../ChatTemplateOverlay.js';

function chain(chainId: string, label: string): ChainTemplate {
  return { chainId, packName: 'pack', label, description: `${label} description` };
}

beforeEach(() => {
  catalog = [chain('cs.launch', 'Campaign launch'), chain('cs.weekly', 'Campaign weekly report')];
  owned = [{ displayName: 'Campaign launch', slug: 'campaign-launch', description: 'd', toolName: 't1', workflowId: 'wf.owned.1', fromChainId: 'cs.launch' }];
});
afterEach(cleanup);

async function openGallery() {
  await act(async () => {
    render(<ChatTemplateOverlay intent={{ kind: 'browse-templates', prefix: '' }} onClose={vi.fn()} onInstantiated={vi.fn()} />);
  });
}

/** The gallery card for a template. Labels are bidi-isolated (pack-authored text),
 *  so match on the card's text rather than an exact text node. */
function cardOf(label: string): HTMLElement {
  const card = Array.from(document.querySelectorAll('article')).find((a) => (a.textContent ?? '').includes(label));
  if (!card) throw new Error(`no card for ${label}`);
  return card;
}

describe('chat template overlay: a second copy of an owned template', () => {
  it('the gallery marks only the owned template with "You have a copy"', async () => {
    await openGallery();
    expect(cardOf('Campaign launch').textContent).toContain('templateYouHaveACopy');
    expect(cardOf('Campaign weekly report').textContent).not.toContain('templateYouHaveACopy');
  });

  it('the owned template\'s preflight says "Add another copy"', async () => {
    await openGallery();
    const use = cardOf('Campaign launch').querySelector('button');
    if (!use) throw new Error('no use button');
    await act(async () => { fireEvent.click(use); });
    const dialog = await screen.findByRole('dialog', { name: 'preflight cs.launch' });
    expect(dialog.textContent).toContain('templateAddAnotherCopy');
  });

  it('a template with no owned copy keeps the preflight\'s own label', async () => {
    await openGallery();
    const use = cardOf('Campaign weekly report').querySelector('button');
    if (!use) throw new Error('no use button');
    await act(async () => { fireEvent.click(use); });
    const dialog = await screen.findByRole('dialog', { name: 'preflight cs.weekly' });
    expect(dialog.textContent).toContain('preflightConfirm');
    expect(dialog.textContent).not.toContain('templateAddAnotherCopy');
  });
});
