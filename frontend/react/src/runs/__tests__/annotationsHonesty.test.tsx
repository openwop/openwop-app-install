/**
 * RUN-R2-1 (runs round 2) — a failed annotations read must not render as
 * "no annotations".
 *
 * The chain that lied: `feedbackClient.listAnnotations` caught EVERY failure
 * into `[]` (its own docstring claimed "throws only on unexpected failures" —
 * a mitigation the code did not have); `listAnnotationsCached` then CACHED the
 * fabricated `[]` for 60s; the review queue rendered "flagged (0)" as a
 * confident answer after any transient blip. The "0 of 47 tested" family on
 * the forensics surface.
 *
 * Both polarities asserted: capability-absent (SDK null) still resolves `[]`
 * (a real answer), while an unexpected failure REJECTS; the hook keeps the
 * fulfilled runs' real annotations and exposes `degraded` for the rest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const sdk = vi.hoisted(() => ({ listAnnotations: vi.fn() }));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    client: { runs: { listAnnotations: sdk.listAnnotations } },
    // ADR 0647: every client read binds the run id to the active tenant via
    // `bound()` (a `me/workspaces` lookup). This test is about degraded
    // semantics, not binding — stub the bind to identity, or the real lookup
    // rejects under jsdom and BOTH runs read as failed (the '' vs 'r-ok' red).
    bound: vi.fn(async (id: string) => id),
    getCapabilities: vi.fn().mockResolvedValue({ feedback: { supported: true } }),
  };
});

import { listAnnotations } from '../../client/feedbackClient.js';
import { useRunAnnotations } from '../useRunAnnotations.js';

const flagAnn = {
  annotationId: 'a1',
  target: { runId: 'r-ok' },
  signal: { kind: 'flag' as const },
  actor: { principalRef: 'user:tester' },
  createdAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('listAnnotations — the client honors its contract', () => {
  it('capability-absent (SDK null) resolves [] — a real answer, not a failure', async () => {
    sdk.listAnnotations.mockResolvedValue(null);
    await expect(listAnnotations('r1')).resolves.toEqual([]);
  });

  it('an unexpected failure REJECTS instead of fabricating "no annotations"', async () => {
    sdk.listAnnotations.mockRejectedValue(new Error('network down'));
    await expect(listAnnotations('r1')).rejects.toThrow('network down');
  });
});

function Probe({ ids }: { ids: string[] }): JSX.Element {
  const { byRun, degraded, feedbackOn } = useRunAnnotations(ids);
  return (
    <div>
      <span data-testid="degraded">{String(degraded)}</span>
      <span data-testid="feedback-on">{String(feedbackOn)}</span>
      <span data-testid="flagged-runs">{[...byRun.entries()].filter(([, a]) => a.length > 0).map(([id]) => id).join(',')}</span>
    </div>
  );
}

describe('useRunAnnotations — partial failure degrades honestly', () => {
  it('keeps the fulfilled run\'s real annotations AND marks the pass degraded', async () => {
    sdk.listAnnotations.mockImplementation((id: string) =>
      id === 'r-ok' ? Promise.resolve([flagAnn]) : Promise.reject(new Error('blip')));
    render(<Probe ids={['r-ok', 'r-fail']} />);
    // The success half must survive (a degraded pass is not an empty pass)…
    expect((await screen.findByTestId('flagged-runs')).textContent).toBe('r-ok');
    // …and the failure half must be DECLARED, not absorbed into "0 flagged".
    expect(screen.getByTestId('degraded').textContent).toBe('true');
  });

  it('a fully clean pass is NOT degraded (the polarity that keeps the warning meaningful)', async () => {
    sdk.listAnnotations.mockResolvedValue([flagAnn]);
    render(<Probe ids={['r-clean']} />);
    expect((await screen.findByTestId('flagged-runs')).textContent).toBe('r-clean');
    expect(screen.getByTestId('degraded').textContent).toBe('false');
  });
});
