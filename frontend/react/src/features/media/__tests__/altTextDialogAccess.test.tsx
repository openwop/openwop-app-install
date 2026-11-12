/**
 * ADR 1100 D8 — "Generate with AI" is offered only where the accessibility
 * feature is on and entitled. The route checks both (`requireFeatureEnabled`),
 * and the toggle's registered default is OFF, so on a fresh install the button
 * answered every click with "Accessibility is not enabled for this tenant."
 * Typing alt text and marking an image decorative are media's own and stay.
 *
 * Red when: the button renders while the toggle is off or the help still
 * promises it (case 1); it is clickable, or gives no reason, while the plan
 * locks it (case 2); it is clickable while access is still loading (case 3); or
 * it is not offered when access is on (case 4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MediaAsset } from '../mediaClient.js';
import type { FeatureAccess } from '../../../featureToggles/FeatureAccessContext.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const access = vi.hoisted(() => ({ current: {} as Partial<FeatureAccess & { loading: boolean }> }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFeatureAccess: () => makeFeatureAccess(access.current),
}));

import { AltTextDialog } from '../AltTextDialog.js';

const asset: MediaAsset = {
  assetId: 'asset-1', orgId: 'org1', name: 'bike.png', contentType: 'image/png',
  sizeBytes: 1024, tags: [], usageCount: 0, serveUrl: '/asset-1',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const mount = (): void => { render(<AltTextDialog orgId="org1" asset={asset} onClose={() => {}} onSaved={() => {}} />); };
const generate = (): HTMLElement | null => screen.queryByRole('button', { name: /Generate with AI/ });

afterEach(cleanup);

describe('AltTextDialog — Generate with AI follows feature access', () => {
  it('is hidden while the toggle is off, and the help stops promising it; typing and decorative stay', () => {
    access.current = { enabled: false, status: 'off', loading: false };
    mount();
    expect(generate()).toBeNull();
    expect(screen.queryByText(/generate one with AI/)).toBeNull();
    expect(screen.getByText(/Write a concise description, or mark the image decorative/)).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('is disabled, with the reason, while the plan locks the feature', () => {
    access.current = { enabled: true, entitled: false, locked: true, loading: false };
    mount();
    const b = generate() as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(b.getAttribute('aria-describedby')!)?.textContent).toMatch(/not included in this workspace/);
    expect(screen.queryByText(/generate one with AI/)).toBeNull(); // the help does not promise it either
  });

  it('is disabled while access is still loading (no layout jump, no early click)', () => {
    access.current = { enabled: false, loading: true };
    mount();
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
  });

  it('is offered when the feature is on and entitled', () => {
    access.current = { enabled: true, loading: false };
    mount();
    expect((generate() as HTMLButtonElement).disabled).toBe(false);
  });
});
