/**
 * The CMS "Public" preview frame fills without waiting for React's `onLoad`.
 * Chromium completes a src-less iframe's about:blank document at insertion and
 * fires its `load` before React listens, so a frame that mounted only from
 * `onLoad` stayed blank on every page. jsdom delivers `load` later, so this
 * test models Chromium by keeping the frame's `load` from reaching React.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { PublicPreviewFrame } from '../PublicPreviewFrame.js';

const swallowFrameLoad = (e: Event): void => {
  if (e.target instanceof HTMLIFrameElement) e.stopImmediatePropagation();
};

afterEach(() => {
  cleanup();
  document.removeEventListener('load', swallowFrameLoad, true);
});

describe('PublicPreviewFrame', () => {
  it('portals its children into the frame when no load event reaches React', async () => {
    document.addEventListener('load', swallowFrameLoad, true);
    const { container, rerender } = render(<PublicPreviewFrame title="Preview"><p>Inside the frame</p></PublicPreviewFrame>);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const doc = container.querySelector('iframe')!.contentDocument!;
    const seen = doc.body.textContent;
    const cloned = doc.getElementById('cms-pv-stylesheets') !== null;
    // jsdom discards a removed frame's document; empty the portal before
    // cleanup removes the frame, or React's teardown throws (jsdom-only).
    rerender(<PublicPreviewFrame title="Preview">{null}</PublicPreviewFrame>);
    expect(seen).toContain('Inside the frame');
    expect(cloned).toBe(true);
  });
});
