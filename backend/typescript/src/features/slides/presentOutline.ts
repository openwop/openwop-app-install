/**
 * The slides present-mode OUTLINE projection (ADR 0328 Phase 4) — what the
 * phone controller may read: frame names + speaker notes + skip flags. Pure
 * over the editor/artifact doc shape; registered per canvas type through the
 * chassis-level registry (the QR remote is a core capability).
 */
import { registerPresentOutlineProvider, type PresentOutline } from '../../host/presentRemote.js';

export function slidesPresentOutline(state: Record<string, unknown>): PresentOutline {
  const slides = Array.isArray(state.slides) ? state.slides : [];
  return {
    title: typeof state.title === 'string' ? state.title : 'Untitled deck',
    frames: slides.map((raw, i) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const fromTitle = typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 80) : '';
      const name = typeof s.name === 'string' && s.name.trim() ? s.name : (fromTitle || `Slide ${i + 1}`);
      return {
        name,
        ...(typeof s.notes === 'string' && s.notes ? { notes: s.notes } : {}),
        ...(s.skip === true ? { skip: true } : {}),
      };
    }),
  };
}

export function registerSlidesPresentOutline(): void {
  registerPresentOutlineProvider('canvas.slides', slidesPresentOutline);
}
