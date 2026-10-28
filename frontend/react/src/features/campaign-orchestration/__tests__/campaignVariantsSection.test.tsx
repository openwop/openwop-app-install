/**
 * ADR 0946 P5 — the campaign's Variants section.
 *
 *   - off for the workspace → renders nothing (no empty card for a feature
 *     the workspace does not have);
 *   - a failed read is said with a retry, never shown as "no sets";
 *   - a set opens as a concept board, with the version history, and an older
 *     version reads "Superseded";
 *   - diversity and pre-flight that have not run are labelled, not hidden.
 *
 * Sabotage: mapping a failed read to an empty list reds the failed case;
 * rendering the card when off reds the off case; showing the head instead of
 * the chosen version reds the history case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({ listVariantSets: vi.fn(), listVariantSetVersions: vi.fn() }));
vi.mock('../variantsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listVariantSets: h.listVariantSets, listVariantSetVersions: h.listVariantSetVersions }));

import { CampaignVariantsSection } from '../CampaignVariantsSection.js';
import { FeatureDisabledError } from '../campaignStudioClient.js';
import type { VariantSet } from '../variantsClient.js';

const set = (version: number, headline: string, status: VariantSet['status']): VariantSet => ({
  setId: 'vs_1', campaignId: 'c1', version, headVersion: 2, hash: `${version}`.repeat(64), status,
  concepts: [{ conceptId: 'k1', axes: { angle: 'Saves an hour', hook: 'benefit', visual: 'product_hero', format: 'static' }, rationale: 'Time is the objection.' }],
  members: [{ memberId: 'm1', conceptId: 'k1', channel: 'meta.feed', kind: 'copy', ref: { copy: { headline } }, contentHash: 'x' }],
  createdAt: '2026-10-20T10:00:00.000Z',
});

beforeEach(() => { h.listVariantSets.mockReset(); h.listVariantSetVersions.mockReset(); });
afterEach(cleanup);

describe('CampaignVariantsSection', () => {
  it('renders nothing when the variant factory is off', async () => {
    h.listVariantSets.mockRejectedValue(new FeatureDisabledError('Creative variant factory is not enabled for this tenant.'));
    const { container } = render(<CampaignVariantsSection campaignId="c1" />);
    await vi.waitFor(() => expect(h.listVariantSets).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });

  it('a failed read is said, with a retry', async () => {
    h.listVariantSets.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    render(<CampaignVariantsSection campaignId="c1" />);
    expect(await screen.findByText('Variant sets could not be loaded. Nothing has changed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No variant sets yet/)).toBeTruthy();
  });

  it('opens a set as a concept board, with history; an older version reads Superseded', async () => {
    h.listVariantSets.mockResolvedValue([set(2, 'Get an hour back', 'draft')]);
    h.listVariantSetVersions.mockResolvedValue([set(2, 'Get an hour back', 'draft'), set(1, 'Save an hour', 'superseded')]);
    render(<CampaignVariantsSection campaignId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: '1 concept, 1 member' }));
    expect(await screen.findByRole('article', { name: 'Concept: Saves an hour' })).toBeTruthy();
    expect(screen.getByText('Benefit')).toBeTruthy();
    expect(screen.getByText('Get an hour back')).toBeTruthy();
    expect(screen.getByText('Diversity has not been scored for this version yet.')).toBeTruthy();
    expect(screen.getByText('Pre-flight has not run on this version yet.')).toBeTruthy();
    const history = await screen.findByRole('list', { name: 'Version history' });
    expect(history.textContent).toContain('Superseded');
    fireEvent.click(screen.getByRole('button', { name: 'Version 1' }));
    expect(await screen.findByText('Save an hour')).toBeTruthy();
    expect(screen.queryByText('Get an hour back')).toBeNull();
  });
});
