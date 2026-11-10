/**
 * CONV-6 — the multi-tab chat deck (ADR 0140) is a FRONTEND-ONLY feature, but the backend
 * still DECLARES its toggle so the FE `useFeatureAccess('multi-tab-chat')` gate resolves.
 * This guards that declaration against the FE's real gate (`ChatTab.tsx`, read as source) and
 * the user's default (ON, per-USER, ADR 0978), plus the no-backend-surface invariant.
 *
 * Red when (sabotage-witnessed): the default goes off; the bucket unit moves off `user`;
 * `registerRoutes` touches its deps.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { multiTabChatFeature } from '../src/features/multi-tab-chat/feature.js';

describe('multi-tab-chat feature (ADR 0140)', () => {
  it('declares the toggle the FE gate depends on (ON since 2026-10-25, per-USER)', () => {
    expect(multiTabChatFeature.id).toBe('multi-tab-chat');
    expect(multiTabChatFeature.toggleDefault?.id).toBe('multi-tab-chat');
    // The other side of the parity: the gate the chat actually calls.
    const chatTab = readFileSync(new URL('../../../frontend/react/src/chat/ChatTab.tsx', import.meta.url), 'utf8');
    expect(chatTab).toContain("useFeatureAccess('multi-tab-chat')");
    expect(multiTabChatFeature.toggleDefault?.status).toBe('on');
    // A per-user UI preference — NOT tenant-bucketed (a future change must not silently flip this).
    expect(multiTabChatFeature.toggleDefault?.bucketUnit).toBe('user');
  });

  it('registers NO backend surface (frontend-only — registerRoutes is a no-op)', () => {
    // It must not register anything, so it must never read its deps.
    const read: string[] = [];
    const deps = new Proxy({}, { get: (_target, key) => { read.push(String(key)); return undefined; } });
    multiTabChatFeature.registerRoutes(deps as never);
    expect(read).toEqual([]);
  });
});
