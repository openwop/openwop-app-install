/**
 * UX_UPGRADE-app-builder ROUND 3 — AB-R2-1, the "try to fix" affordance.
 *
 * A failed AI-AUTHORING turn (`structured_output_invalid` — the invalid-model-
 * output class the backend's bounded error-fed repair guards) and an empty
 * completion both used to classify with NO action: the ErrorCard rendered a
 * dead end while the repair loop sat one click away. Both now carry the retry
 * action, and the card renders the button when the retry callback is wired.
 *
 * The deliberate NON-retry polarity is pinned too: `safety_filter` stays
 * action-less — re-running filtered content is not a fix, and a blanket
 * "always offer retry" change must fail here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { classifyChatError } from '../lib/errorClassify.js';
import { ErrorCard } from '../ErrorCard.js';

afterEach(cleanup);

describe('AB-R2-1 — authoring failures offer a retry; filtered content never does', () => {
  it('structured_output_invalid classifies WITH a retry action', () => {
    const k = classifyChatError({ code: 'structured_output_invalid', message: 'schema mismatch' });
    expect(k.action?.kind).toBe('retry');
  });

  it('empty_completion classifies WITH a retry action', () => {
    const k = classifyChatError({ code: 'empty_completion', message: 'no output' });
    expect(k.action?.kind).toBe('retry');
  });

  it('safety_filter stays action-less (re-running filtered content is not a fix)', () => {
    const k = classifyChatError({ code: 'safety_filter', message: 'filtered' });
    expect(k.action).toBeUndefined();
  });

  it('the card renders the retry button for an authoring failure when wired', () => {
    const onRetry = vi.fn();
    render(<ErrorCard error={{ code: 'structured_output_invalid', message: 'schema mismatch' }} onRetry={onRetry} />);
    const btn = screen.getByRole('button', { name: /retry/i });
    btn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('the card renders NO button when the callback is absent (no dead onClick)', () => {
    render(<ErrorCard error={{ code: 'structured_output_invalid', message: 'schema mismatch' }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
