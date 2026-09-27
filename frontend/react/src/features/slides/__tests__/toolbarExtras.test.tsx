/**
 * UX_UPGRADE-slides SL-G5 + SL-G6 — the editor toolbar's two honesty gaps.
 *
 * SL-G5: the .pptx import returns a per-item list of what it could NOT bring
 * across, and one of those lines is "deck truncated to 100 slides (had N)".
 * The toolbar counted the list, showed the count in an auto-dismissing toast
 * and navigated away — so losing 37 slides read exactly like skipping 37
 * images. The reasons are now reported before the user leaves.
 *
 * SL-G6: Present and Presenter view load the SAVED canvas from the server, the
 * same as Export does. Export hinted when the doc was dirty; these two didn't,
 * so an unsaved edit was silently missing from what the audience saw.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { slidesDefinition } from '../definition.js';

// vi.mock factories are hoisted above every top-level declaration, so the spies
// they close over have to be created inside vi.hoisted.
const { navigate, toastInfo, toastSuccess } = vi.hoisted(() => ({
  navigate: vi.fn(), toastInfo: vi.fn(), toastSuccess: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

// Spread the real module — enumerating it strands every other export the
// component (and Modal) reaches for.
vi.mock('../../../ui/index.js', async (orig) => {
  const real = await orig<typeof import('../../../ui/index.js')>();
  return { ...real, toast: { ...real.toast, info: toastInfo, success: toastSuccess } };
});

const Extras = slidesDefinition.ToolbarExtras!;
const view = (dirty: boolean): ReturnType<typeof render> =>
  render(<Extras orgId="org-1" canvasId="cv-1" docName="Deck" dirty={dirty} />);

// jsdom's File implements no `arrayBuffer()`, so the real reader has to be
// supplied here — without it the import throws and every assertion below reads
// as "the report never rendered" rather than "the environment lacks a method".
const pptx = (): File => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const f = new File([bytes], 'Q3 review.pptx');
  Object.defineProperty(f, 'arrayBuffer', { value: async () => bytes.buffer });
  return f;
};

const importReturns = (skipped: string[]): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ canvasId: 'cv-new', skipped }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  )));
};

const doImport = async (container: HTMLElement): Promise<void> => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [pptx()] } }); });
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { navigate.mockClear(); toastInfo.mockClear(); toastSuccess.mockClear(); });

describe('SL-G5 — the import reports WHAT it skipped', () => {
  it('shows every reason, and names the truncation specifically', async () => {
    importReturns([
      'slide 4: images/charts/tables are not imported (text only)',
      'deck truncated to 100 slides (had 137)',
    ]);
    const { container } = view(false);
    await doImport(container);

    const dialog = screen.getByRole('dialog');
    // The load-bearing line: 37 slides are gone, and a count alone hid that.
    expect(dialog.textContent).toContain('deck truncated to 100 slides (had 137)');
    expect(dialog.textContent).toContain('slide 4: images/charts/tables are not imported');
    // Reporting is not the same as blocking — nothing navigates yet.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the imported deck from the report', async () => {
    importReturns(['deck truncated to 100 slides (had 137)']);
    const { container } = view(false);
    await doImport(container);
    await act(async () => { fireEvent.click(screen.getByText('Open the imported deck')); });
    expect(navigate).toHaveBeenCalledWith('/slides/cv-new');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismissing still opens the deck — it WAS created', async () => {
    importReturns(['slide 1: images/charts/tables are not imported (text only)']);
    const { container } = view(false);
    await doImport(container);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(navigate).toHaveBeenCalledWith('/slides/cv-new');
  });

  it('a clean import needs no report — it navigates straight through', async () => {
    importReturns([]);
    const { container } = view(false);
    await doImport(container);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastSuccess).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/slides/cv-new');
  });
});

describe('SL-G6 — present warns about unsaved edits, like export does', () => {
  it('hints on Present and on Presenter view when the doc is dirty', async () => {
    view(true);
    await act(async () => { fireEvent.click(screen.getByText('Present')); });
    expect(navigate).toHaveBeenCalledWith('/slides/cv-1/present');
    expect(toastInfo).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByText('Presenter view')); });
    expect(navigate).toHaveBeenCalledWith('/slides/cv-1/present?presenter=1');
    expect(toastInfo).toHaveBeenCalledTimes(2);
  });

  it('stays quiet on a clean doc — and still navigates', async () => {
    view(false);
    await act(async () => { fireEvent.click(screen.getByText('Present')); });
    expect(navigate).toHaveBeenCalledWith('/slides/cv-1/present');
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe('SL-G8 (round 3) — coded skip reasons LOCALIZE; unknown codes fall back to the derived strings', () => {
  const importReturnsCoded = (skipped: string[], skippedCoded: unknown[]): void => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ canvasId: 'cv-new', skipped, skippedCoded }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )));
  };

  it('renders the CLIENT-side wording from the coded pair, not the server sentence', async () => {
    importReturnsCoded(
      ['slide 4: images/charts/tables are not imported (text only)', 'deck truncated to 100 slides (had 137)'],
      [{ code: 'rich-content', slide: 4 }, { code: 'truncated', total: 137 }],
    );
    const { container } = view(false);
    await doImport(container);
    const dialog = screen.getByRole('dialog');
    // The localized rendering (capital S / "it had") — DISCRIMINABLE from the
    // server's derived sentence, so this cannot pass via the fallback lane.
    expect(dialog.textContent).toContain('Slide 4: images, charts and tables are not imported (text only).');
    expect(dialog.textContent).toContain('Deck truncated to 100 slides (it had 137).');
    expect(dialog.textContent).not.toContain('slide 4: images/charts/tables');
  });

  it('an UNKNOWN code drops the whole coded lane — the derived strings render instead of a half-localized guess', async () => {
    importReturnsCoded(
      ['slide 2: images/charts/tables are not imported (text only)', 'future reason'],
      [{ code: 'rich-content', slide: 2 }, { code: 'watermarked', foo: 1 }],
    );
    const { container } = view(false);
    await doImport(container);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('slide 2: images/charts/tables are not imported (text only)');
    expect(dialog.textContent).toContain('future reason');
    expect(dialog.textContent).not.toContain('Slide 2: images, charts');
  });
});
