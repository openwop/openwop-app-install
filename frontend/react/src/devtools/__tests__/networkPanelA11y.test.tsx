/**
 * `DTU-1` / `DTU-2` — the captured-requests list owes a screen-reader user the column
 * context the grid gives sighted users, and SOME perception that a stream is arriving.
 *
 * `DTU-2` is deliberately NOT what the row asked for. The filed row wanted `aria-live`
 * on the capture list; that announces every captured request, and one page load is 20+
 * calls — a firehose is worse than silence. So the list stays silent and a THROTTLED
 * polite status carries the count instead. The tests pin both halves: the row label
 * names its fields (with their real values), the list itself — WITH a row rendered — has
 * no live region, and the status stays silent until the throttle window elapses and
 * then carries the count.
 *
 * Sabotage that turns it red: dropping the row `aria-label` fields (method/status/
 * duration), `aria-live` on the list or a row, rendering the status text before the
 * first tick, or shortening `CAPTURE_STATUS_MS`.
 */
import { render, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) =>
      v ? `${k}:${Object.entries(v).map(([a, b]) => `${a}=${String(b)}`).join(',')}` : k,
  }),
}));

import { NetworkPanel } from '../NetworkPanel.js';
import { clearNetworkEntries, installNetworkRecorder, listNetworkEntries } from '../networkRecorder.js';

// Install the REAL recorder once over a stubbed fetch, so every captured entry is the
// shape the production wrapper produces (the recorder's install is a module-level once).
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
  installNetworkRecorder();
});

afterEach(() => { vi.useRealTimers(); cleanup(); clearNetworkEntries(); });

/** Capture ONE request through the recorder's own fetch wrapper. */
async function captureOne(): Promise<void> {
  await window.fetch('/api/widgets', { method: 'POST', body: '{"name":"x"}' });
  expect(listNetworkEntries().length, 'the recorder captured the call — otherwise this leg is vacuous').toBe(1);
}

describe('DTU-1 — column context for the captured-requests list', () => {
  it('with no rows there is no header strip (nothing to head)', () => {
    render(<NetworkPanel open onClose={() => {}} />);
    // ui/Modal renders through a PORTAL, so the query must be document-wide.
    expect(document.querySelector('.netpanel-cols')).toBeNull();
  });

  it('with a captured row: the strip renders, is hidden from SR, and the row LABEL names its fields', async () => {
    await captureOne();
    render(<NetworkPanel open onClose={() => {}} />);

    const cols = document.querySelector('.netpanel-cols');
    expect(cols, 'sighted users get real column headers').not.toBeNull();
    expect(cols!.getAttribute('aria-hidden'), 'and SR users get the same context from the row label instead').toBe('true');
    expect(cols!.textContent).toContain('colMethod');
    expect(cols!.textContent).toContain('colDuration');

    const row = document.querySelector('.netpanel-row-head');
    expect(row).not.toBeNull();
    const label = row!.getAttribute('aria-label') ?? '';
    // The mocked `t` echoes `key:name=value,...`, so this proves the FIELDS are named
    // WITH their values — the thing the missing column headers actually cost an SR user.
    expect(label).toContain('rowLabel:');
    expect(label).toContain('method=POST');
    expect(label).toContain('path=/api/widgets');
    expect(label, 'status is the real code, not the pending placeholder').toContain('status=200');
    expect(label, 'duration is a measured number, not the pending placeholder').toMatch(/duration=\d/);
  });
});

describe('DTU-2 — the list does NOT announce every request', () => {
  it('the capture list carries no live region', async () => {
    await captureOne();
    render(<NetworkPanel open onClose={() => {}} />);
    const list = document.querySelector('.netpanel-list');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('.netpanel-row'), 'a row is rendered — otherwise the inner check is vacuous').toHaveLength(1);
    expect(list!.getAttribute('aria-live'), 'a live list would announce every captured call').toBeNull();
    expect(list!.querySelector('[aria-live]'), 'and nothing inside it may be live either').toBeNull();
  });

  it('a polite status exists for the count, and says nothing before the first throttled tick', () => {
    render(<NetworkPanel open onClose={() => {}} />);
    const status = document.querySelector('.netpanel-head-title [role="status"]');
    expect(status, 'the panel offers a polite status').not.toBeNull();
    expect(status!.textContent, 'silent until the throttle fires — an empty panel announces nothing').toBe('');
  });

  it('the status carries the count only once the throttle window (1500 ms) has elapsed', async () => {
    await captureOne();
    vi.useFakeTimers();
    render(<NetworkPanel open onClose={() => {}} />);
    const status = document.querySelector('.netpanel-head-title [role="status"]');
    expect(status).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1499); });
    expect(status!.textContent, 'still inside the throttle window').toBe('');
    act(() => { vi.advanceTimersByTime(1); });
    expect(status!.textContent).toBe('captureStatus:count=1');
  });
});
