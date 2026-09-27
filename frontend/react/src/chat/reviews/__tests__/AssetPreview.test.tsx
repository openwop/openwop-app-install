import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AssetPreview } from '../AssetPreview.js';
import type { ReviewAsset } from '../reviewClient.js';

afterEach(cleanup);

/**
 * AssetPreview media branches (ADR 0458 §2.4) — a generated image/video renders
 * INLINE so the approver sees what they approve. The model-influenced serve URL
 * MUST pass the shared `mediaSrc` allowlist; a disallowed scheme or an
 * unknown/missing MIME falls through to the text path (never guessed).
 */
describe('AssetPreview media rendering', () => {
  it('renders an image with a sanitized src for an image MIME', () => {
    const asset: ReviewAsset = { label: 'Day 1 cover', url: 'https://cdn.example/img.png', mimeType: 'image/png' };
    const { container } = render(<AssetPreview asset={asset} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('https://cdn.example/img.png');
    // The label is the accessible name; no raw-URL text dump.
    expect(img!.getAttribute('alt')).toBe('Day 1 cover');
  });

  it('renders a controls-enabled <video> for a video MIME', () => {
    const asset: ReviewAsset = { label: 'Reel', url: 'https://cdn.example/clip.mp4', mimeType: 'video/mp4' };
    const { container } = render(<AssetPreview asset={asset} />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video!.getAttribute('src')).toBe('https://cdn.example/clip.mp4');
    expect(video!.hasAttribute('controls')).toBe(true);
    expect(video!.getAttribute('preload')).toBe('metadata');
  });

  it('falls back to the text path when the URL scheme is disallowed (XSS guard)', () => {
    const asset: ReviewAsset = { url: 'javascript:alert(1)', mimeType: 'image/png', content: 'a drafted lesson' };
    const { container } = render(<AssetPreview asset={asset} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('a drafted lesson')).toBeTruthy();
  });

  it('falls back to the text path for an unknown/unsupported MIME', () => {
    const asset: ReviewAsset = { url: 'https://cdn.example/archive.zip', mimeType: 'application/zip', content: 'a drafted lesson' };
    const { container } = render(<AssetPreview asset={asset} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('a drafted lesson')).toBeTruthy();
  });

  it('falls back to the artifact-ref text path when a media MIME has no URL', () => {
    // A bound artifact whose media URL never resolved: keep the "open in workbench" ref, never guess.
    const asset: ReviewAsset = { mimeType: 'image/png', artifactId: 'media:asset-1' };
    const { container } = render(<AssetPreview asset={asset} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/media:asset-1/)).toBeTruthy();
  });
});

/**
 * ADR 0459 grade-fix — a TYPED artifact (registered artifactTypeId) dispatches to the
 * review-renderer registry (a humanized card), NOT the raw-JSON markdown path.
 */
describe('AssetPreview typed-artifact dispatch', () => {
  const planContent = JSON.stringify({
    commands: [{ lane: 'substitute', cardId: 'occ:abc', alternativeId: 'alt:xyz' }],
    rationale: 'Swap in something lower-impact this week.',
    display: { summary: '1 change to your plan', lines: ['Swap “Run 5k” for “Brisk 20-min walk”.'] },
  });

  it('renders the humanized kicktodo.plan-revision card (titles, rationale, raw behind a disclosure)', () => {
    const asset: ReviewAsset = { label: 'Plan change', content: planContent, artifactTypeId: 'kicktodo.plan-revision' };
    render(<AssetPreview asset={asset} hideLabel />);
    // The server-resolved humanized line (real titles) + rationale prose render as the
    // primary content — never the opaque ids and never a raw JSON blob as the body.
    expect(screen.getByText('Swap “Run 5k” for “Brisk 20-min walk”.')).toBeTruthy();
    expect(screen.getByText('Swap in something lower-impact this week.')).toBeTruthy();
    // The raw commands are available only behind the collapsed disclosure (not the body).
    expect(screen.getByText(/Show the raw commands/i).closest('details')).toBeTruthy();
  });

  it('falls through to markdown for an UNREGISTERED artifactTypeId (untyped path unchanged)', () => {
    const asset: ReviewAsset = { content: 'plain drafted text', artifactTypeId: 'some.unknown.type' };
    render(<AssetPreview asset={asset} hideLabel />);
    expect(screen.getByText('plain drafted text')).toBeTruthy();
  });
});
