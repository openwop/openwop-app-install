/**
 * ADR 0945 P5 — the fidelity chip and the provenance drawer.
 *
 * - The chip appears ONLY for assets with a generation stamp, and its LABEL
 *   carries the outcome (color-never-alone); a product image with no verdict
 *   reads "Not checked".
 * - The drawer shows the product photo beside the result, each check with its
 *   measured value and limit, and the judge's evidence as plain text (a model's
 *   markup is never rendered as markup).
 * Breaks if the chip shows for plain uploads, a stage-A row loses its value,
 * or judge evidence is injected as HTML.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type * as Client from '../mediaClient.js';
import type { AssetProvenance, MediaAsset } from '../mediaClient.js';

const getAssetProvenance = vi.hoisted(() => vi.fn<typeof Client.getAssetProvenance>());
vi.mock('../mediaClient.js', () => ({ getAssetProvenance, absoluteServeUrl: (u: string) => u }));

import { FidelityChip } from '../MediaViews.js';
import ProvenanceDialog from '../ProvenanceDialog.js';
import { useTranslation } from 'react-i18next';

afterEach(cleanup);

const base: MediaAsset = { assetId: 'masset:1', orgId: 'o', name: 'shot.png', contentType: 'image/png', sizeBytes: 10, tags: [], usageCount: 0, serveUrl: '/assets/x', createdAt: 'x', updatedAt: 'x' };
const grounding = { mode: 'composite' as const, productId: 'prod:mug', sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], provider: 'openwop', model: 'renderer@1', op: 'render' };

function Chip({ a }: { a: MediaAsset }): JSX.Element { const { t } = useTranslation('media'); return <div>{FidelityChip({ a, t })}</div>; }

describe('FidelityChip', () => {
  it('is absent for a plain upload', () => {
    render(<Chip a={base} />);
    expect(document.querySelector('.chip')).toBeNull();
  });
  it('names the outcome in words', () => {
    render(<Chip a={{ ...base, lineage: { generatedBy: 'ai', grounding: { ...grounding, fidelity: { verdictId: 'v', outcome: 'needs_review', rulesetVersion: 'r' } } } }} />);
    expect(screen.getByText('Needs review')).toBeTruthy();
    cleanup();
    render(<Chip a={{ ...base, lineage: { generatedBy: 'ai', grounding } }} />);
    expect(screen.getByText('Not checked')).toBeTruthy();
  });
});

describe('ProvenanceDialog', () => {
  it('shows source beside result, checks with value/limit, and judge evidence as text', async () => {
    const prov: AssetProvenance = {
      assetId: 'masset:1', generatedBy: 'ai', grounding,
      sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64), present: true, name: 'mug.png', contentType: 'image/png', serveUrl: '/assets/src' }],
      verdict: {
        verdictId: 'v', assetSha256: 'c'.repeat(64), outcome: 'fail', mode: 'composite', rulesetVersion: 'fid-a-1', checkedAt: '2026-10-20T00:00:00Z',
        checks: [{ id: 'colour_delta_e', status: 'fail', value: 44.8, threshold: 8, detail: 'x' }],
        judge: { provider: 'anthropic', model: 'm', repaired: false, results: [{ attribute: 'logo', answer: 'mismatch', evidence: '<b>swapped</b> mark' }] },
      },
    };
    getAssetProvenance.mockResolvedValue(prov);
    render(<ProvenanceDialog orgId="o" asset={base} onClose={() => undefined} />);
    expect(await screen.findByText('Source: mug.png')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('Colour matches')).toBeTruthy();
    expect(screen.getByText(/44\.8.*limit 8/)).toBeTruthy();
    expect(screen.getByText('<b>swapped</b> mark')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });
});
