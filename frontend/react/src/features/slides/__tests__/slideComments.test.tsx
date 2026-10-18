/**
 * ADR 0886 D5 — the slides toolbar's per-slide Comments control.
 *
 * `comments` ships OFF, so the control must be ABSENT (not disabled) while it
 * is off: a deck never offers a door that only opens onto "not enabled". When
 * on, it opens the ONE shared CommentsPanel on `<canvasId>#<slideId>` for the
 * slide the editor has selected, and hints when unsaved edits mean the slide
 * may not be in the saved deck yet.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const { access, toastInfo, panelProps } = vi.hoisted(() => ({
  access: { enabled: false },
  toastInfo: vi.fn(),
  panelProps: [] as Array<{ orgId: string; resourceType: string; resourceId: string }>,
}));

vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled }),
}));
vi.mock('../../comments/CommentsPanel.js', () => ({
  CommentsPanel: (p: { orgId: string; resourceType: string; resourceId: string }) => {
    panelProps.push(p);
    return <div data-testid="comments-panel">{p.resourceId}</div>;
  },
}));
vi.mock('../../../ui/index.js', async (orig) => {
  const real = await orig<typeof import('../../../ui/index.js')>();
  return { ...real, toast: { ...real.toast, info: toastInfo } };
});
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

import { slidesDefinition } from '../definition.js';

const Extras = slidesDefinition.ToolbarExtras!;
const SLIDE = { id: 'ask', name: 'The ask' };

beforeEach(() => { access.enabled = false; toastInfo.mockClear(); panelProps.length = 0; });
afterEach(cleanup);

describe('slides toolbar — per-slide comments (ADR 0886 D5)', () => {
  it('is absent while the comments feature is off', () => {
    render(<Extras orgId="org-1" canvasId="cv-1" docName="Deck" dirty={false} activeFrame={SLIDE} />);
    expect(screen.queryByRole('button', { name: /comments/i })).toBeNull();
  });

  it('is absent with no selected slide, even when comments is on', () => {
    access.enabled = true;
    render(<Extras orgId="org-1" canvasId="cv-1" docName="Deck" dirty={false} activeFrame={null} />);
    expect(screen.queryByRole('button', { name: /comments/i })).toBeNull();
  });

  it('opens the shared panel on <canvasId>#<slideId> for the selected slide', () => {
    access.enabled = true;
    render(<Extras orgId="org-1" canvasId="cv-1" docName="Deck" dirty={false} activeFrame={SLIDE} />);
    fireEvent.click(screen.getByRole('button', { name: /comments/i }));
    expect(screen.getByTestId('comments-panel').textContent).toBe('cv-1#ask');
    expect(panelProps.at(-1)).toEqual({ orgId: 'org-1', resourceType: 'canvas_slides', resourceId: 'cv-1#ask' });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('a saved slide in an edited deck opens the thread with a quiet unsaved note (no toast)', () => {
    access.enabled = true;
    render(<Extras orgId="org-1" canvasId="cv-1" docName="Deck" dirty activeFrame={{ ...SLIDE, saved: true }} />);
    fireEvent.click(screen.getByRole('button', { name: /comments/i }));
    expect(screen.getByTestId('comments-panel')).toBeTruthy();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('a slide added since the last save says "save first" instead of opening a thread that cannot resolve (SL2UX-3)', () => {
    access.enabled = true;
    render(<Extras orgId="org-1" canvasId="cv-1" docName="Deck" dirty activeFrame={{ ...SLIDE, saved: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /comments/i }));
    expect(screen.queryByTestId('comments-panel')).toBeNull();
    expect(screen.getByText(/Save the deck to start a thread/)).toBeTruthy();
  });
});
