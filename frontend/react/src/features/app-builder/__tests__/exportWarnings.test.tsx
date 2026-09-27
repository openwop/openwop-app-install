/**
 * UX_UPGRADE-app-builder AB-G2 — the code export reports WHAT it could not
 * express in the chosen target.
 *
 * The generator's warnings name the parts of the app that are MISSING from the
 * file the user just downloaded (a component with no react-native equivalent,
 * say). The toolbar counted them into a toast — so the user walked away with
 * incomplete source and no way to learn which parts were incomplete.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { appBuilderDefinition } from '../definition.js';

const { exportCanvasCode, toastSuccess } = vi.hoisted(() => ({
  exportCanvasCode: vi.fn(), toastSuccess: vi.fn(),
}));

vi.mock('../canvasEditorClient.js', async (orig) => ({
  ...(await orig<typeof import('../canvasEditorClient.js')>()),
  exportCanvasCode,
}));
vi.mock('../../../ui/toast.js', async (orig) => {
  const real = await orig<typeof import('../../../ui/toast.js')>();
  return { ...real, toast: { ...real.toast, success: toastSuccess } };
});
// The toolbar self-gates on the code-export toggle; without this the buttons
// render as their not-enabled state and nothing below exists.
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => ({ status: 'on', enabled: true, isBeta: false, variant: null, entitled: true, locked: false, loading: false, resolutionFailed: false }),
}));

const RESULT = { assetToken: 'tok', serveUrl: '/dl/tok', fileName: 'app.zip', fileCount: 9, sizeBytes: 1024 };
const Extras = appBuilderDefinition.ToolbarExtras!;
// This suite verifies the capability report, not jsdom's unimplemented file
// navigation. The real click is covered by browser integration; stub it here
// so an otherwise-green test run has no spurious navigation error output.
vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

const exportNow = async (warnings: string[], preflight?: { code: string; message: string }[]): Promise<void> => {
  exportCanvasCode.mockResolvedValue({ ...RESULT, warnings, ...(preflight ? { preflight } : {}) });
  render(<Extras orgId="o1" canvasId="cv-1" docName="Storefront" dirty={false} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Export code/ })); });
};

afterEach(cleanup);
beforeEach(() => { exportCanvasCode.mockReset(); toastSuccess.mockReset(); });

describe('AB-G2 — the export says what it left out', () => {
  it('lists every warning instead of counting them', async () => {
    await exportNow([
      'screens[0].components[2]: "chart" has no react-tailwind equivalent — omitted',
      'themeColors.accent: unsupported gradient flattened to its first stop',
    ]);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('"chart" has no react-tailwind equivalent');
    expect(dialog.textContent).toContain('unsupported gradient flattened');
    // A count-only summary is exactly what this replaces.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('names the target, since what is expressible depends on it', async () => {
    await exportNow(['screens[0].components[2]: omitted']);
    expect(screen.getByRole('dialog').textContent).toContain('React + Tailwind');
  });

  it('surfaces authoritative preflight notes alongside generator warnings', async () => {
    await exportNow([], [{ code: 'actions_not_generated', message: '2 closed actions will not execute in react-tailwind output.' }]);
    expect(screen.getByRole('dialog').textContent).toContain('2 closed actions will not execute');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('a clean export stays a toast — no dialog to dismiss', async () => {
    await exportNow([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('dismissing the report clears it', async () => {
    await exportNow(['screens[0].components[2]: omitted']);
    // Two dismissals share the name "Close" — the corner × and the footer
    // button, as elsewhere in this app's dialogs. Both must work.
    const closes = screen.getAllByRole('button', { name: 'Close' });
    expect(closes).toHaveLength(2);
    await act(async () => { fireEvent.click(closes[1]!); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
