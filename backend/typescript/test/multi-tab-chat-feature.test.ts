/**
 * CONV-6 — the multi-tab chat deck (ADR 0140) is a FRONTEND-ONLY feature, but the backend
 * still DECLARES its toggle so the FE `useFeatureAccess('multi-tab-chat')` gate resolves.
 * This guards that declaration (shape the FE depends on) + the no-backend-surface invariant.
 */
import { describe, it, expect } from 'vitest';
import { multiTabChatFeature } from '../src/features/multi-tab-chat/feature.js';

describe('multi-tab-chat feature (ADR 0140)', () => {
  it('declares the toggle the FE gate depends on (OFF, per-USER)', () => {
    expect(multiTabChatFeature.id).toBe('multi-tab-chat');
    expect(multiTabChatFeature.toggleDefault?.id).toBe('multi-tab-chat');
    expect(multiTabChatFeature.toggleDefault?.status).toBe('off');
    // A per-user UI preference — NOT tenant-bucketed (a future change must not silently flip this).
    expect(multiTabChatFeature.toggleDefault?.bucketUnit).toBe('user');
  });

  it('registers NO backend surface (frontend-only — registerRoutes is a no-op)', () => {
    // Calling it must not throw and must not register anything (no deps used).
    expect(() => multiTabChatFeature.registerRoutes?.({} as never)).not.toThrow();
  });
});
