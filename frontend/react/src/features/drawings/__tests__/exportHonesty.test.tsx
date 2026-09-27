/**
 * UX_UPGRADE-drawings DRAW-G2 + DRAW-G3 — what the export tells you.
 *
 * DRAW-G3: an image href that could not be inlined stays a host path. That is a
 * deliberate degrade — but it renders as NOTHING once rasterized (SVG-as-image
 * forbids resource loads, which is the whole reason the inliner exists) and
 * leaves an .svg pointing somewhere that resolves nowhere else. The export
 * handed over a file with a hole in it and said nothing.
 *
 * DRAW-G2: when the clipboard refuses, the PNG was produced fine — reporting
 * "Export failed" sends the user back to re-export something that worked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { InteractiveDrawing } from '../InteractiveDrawing.js';
import type { DrawingDoc } from '../definition.js';

const { toastWarning, toastError, toastInfo, copyPngToClipboard, svgStringToPngBlob, inlineSvgImageHrefs } = vi.hoisted(() => ({
  toastWarning: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn(),
  copyPngToClipboard: vi.fn(), svgStringToPngBlob: vi.fn(), inlineSvgImageHrefs: vi.fn(),
}));

vi.mock('../../../ui/toast.js', async (orig) => {
  const real = await orig<typeof import('../../../ui/toast.js')>();
  return { ...real, toast: { ...real.toast, warning: toastWarning, error: toastError, info: toastInfo } };
});
vi.mock('../../../canvas/exportUtils.js', async (orig) => ({
  ...(await orig<typeof import('../../../canvas/exportUtils.js')>()),
  inlineSvgImageHrefs, svgStringToPngBlob, copyPngToClipboard,
  downloadBlob: vi.fn(),
}));

const DOC = { shapes: [{ kind: 'rect', x: 40, y: 40, width: 120, height: 80 }], width: 360, height: 360 } as unknown as DrawingDoc;

const mount = (): void => {
  render(
    <InteractiveDrawing
      doc={DOC}
      selection={null}
      selectedIndices={() => []}
      onSelect={() => {}}
      onClearSelection={() => {}}
      onSetSelection={() => {}}
      patchElement={() => {}}
      patchElements={() => {}}
      deleteElements={() => 0}
    />,
  );
};

const clickExport = async (name: RegExp): Promise<void> => {
  const btn = screen.getAllByRole('button').find((b) => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''));
  expect(btn, `no export control matching ${name}`).toBeTruthy();
  await act(async () => { fireEvent.click(btn!); });
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  inlineSvgImageHrefs.mockResolvedValue({ text: '<svg/>', unresolved: 0 });
  svgStringToPngBlob.mockResolvedValue(new Blob(['x']));
  copyPngToClipboard.mockResolvedValue(true);
});

describe('DRAW-G3 — the export says what it could not embed', () => {
  it('warns when an image could not be inlined, and still exports', async () => {
    inlineSvgImageHrefs.mockResolvedValue({ text: '<svg/>', unresolved: 2 });
    mount();
    await clickExport(/SVG/i);
    expect(toastWarning).toHaveBeenCalled();
    // Degrading beats failing: the file is still produced.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('warns on the PNG path too — that is where the hole is invisible', async () => {
    inlineSvgImageHrefs.mockResolvedValue({ text: '<svg/>', unresolved: 1 });
    mount();
    await clickExport(/PNG/i);
    expect(toastWarning).toHaveBeenCalled();
  });

  it('stays quiet when everything embedded', async () => {
    mount();
    await clickExport(/SVG/i);
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe('DRAW-G2 — a refused clipboard is not a failed export', () => {
  it('reports the COPY as the thing that failed', async () => {
    copyPngToClipboard.mockResolvedValue(false);
    mount();
    const copy = screen.getAllByRole('button').find((b) => /copy/i.test(`${b.textContent} ${b.getAttribute('aria-label')}`));
    expect(copy, 'no copy control').toBeTruthy();
    await act(async () => { fireEvent.click(copy!); });
    expect(toastError).toHaveBeenCalledTimes(1);
    const msg = String(toastError.mock.calls[0]![0]);
    expect(msg).toMatch(/copy/i);
    // The old message sent the user back to re-export a PNG that was fine.
    expect(msg).not.toBe('Export failed');
  });

  it('a genuine rasterization failure is still an export failure', async () => {
    svgStringToPngBlob.mockResolvedValue(null);
    mount();
    await clickExport(/PNG/i);
    expect(String(toastError.mock.calls[0]![0])).toBe('Export failed');
  });
});
