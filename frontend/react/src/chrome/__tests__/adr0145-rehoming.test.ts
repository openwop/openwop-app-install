import { describe, it, expect } from 'vitest';
import { FEATURES } from '../features.js';
import { visibleHubRoutes, tabIdOf } from '../hubProjection.js';

/**
 * ADR 0145 — surface re-homing. Asserts the manifest wiring that consolidates
 * five scattered Platform surfaces: two new consoles project their own tabs (and
 * only their own), the legacy nav entries collapse via `hiddenWhenFeature` while
 * their routes stay reachable, and Channels / Work patterns move to their correct
 * homes. Pure manifest derivations — a manifest edit that breaks the IA is caught.
 */
const byPath = (p: string) => FEATURES.find((r) => r.path === p);
const all = (): boolean => true;

describe('ADR 0145 — Models console', () => {
  it('projects exactly Routing + Leaderboard, in order', () => {
    expect(visibleHubRoutes(FEATURES, all, 'models').map(tabIdOf)).toEqual(['model-router', 'leaderboard']);
  });

  it('the /models container is admin-tier, gated on the `models` toggle, and is not itself a tab', () => {
    const m = byPath('/models');
    expect(m?.tier).toBe('admin');
    expect(m?.nav?.featureId).toBe('models');
    expect(m?.hubTab).toBeUndefined();
  });

  it('collapses the standalone Routing + Leaderboard nav once `models` is enabled', () => {
    expect(byPath('/model-router')?.nav?.hiddenWhenFeature).toBe('models');
    expect(byPath('/leaderboard')?.nav?.hiddenWhenFeature).toBe('models');
  });

  it('keeps the legacy routes reachable for deep links (no redirect)', () => {
    expect(byPath('/model-router')?.element).toBeTruthy();
    expect(byPath('/leaderboard')?.element).toBeTruthy();
  });
});

describe('ADR 0145 — re-graduated tabs gate on their toggle', () => {
  // evals + scheduled-chats are toggle-gated (PR #895): their tab carries a
  // `featureId` so a disabled feature shows in NEITHER the rail nor the console.
  // The always-on surfaces (model-router, chat-widget) carry no featureId.
  it('drops the Leaderboard tab when evals is disabled', () => {
    const isVisible = (id?: string) => id !== 'evals';
    expect(visibleHubRoutes(FEATURES, isVisible, 'models').map(tabIdOf)).toEqual(['model-router']);
  });

  it('drops the Scheduled runs tab when scheduled-agent-chats is disabled', () => {
    const isVisible = (id?: string) => id !== 'scheduled-agent-chats';
    expect(visibleHubRoutes(FEATURES, isVisible, 'chat-deployment').map(tabIdOf)).toEqual(['widgets']);
  });

  it('gates tabs/nav for re-graduated surfaces only; always-on ones stay un-gated', () => {
    expect(byPath('/leaderboard')?.hubTab?.featureId).toBe('evals');
    expect(byPath('/leaderboard')?.nav?.featureId).toBe('evals');
    expect(byPath('/scheduled-chats')?.hubTab?.featureId).toBe('scheduled-agent-chats');
    expect(byPath('/scheduled-chats')?.nav?.featureId).toBe('scheduled-agent-chats');
    expect(byPath('/model-router')?.hubTab?.featureId).toBeUndefined();
    expect(byPath('/widgets')?.hubTab?.featureId).toBeUndefined();
  });
});

describe('ADR 0145 — Chat deployment console', () => {
  it('projects exactly Scheduled runs + Website widget, in order', () => {
    expect(visibleHubRoutes(FEATURES, all, 'chat-deployment').map(tabIdOf)).toEqual(['scheduled-chats', 'widgets']);
  });

  it('the /chat-deployment container is admin-tier, gated on its toggle, and is not itself a tab', () => {
    const c = byPath('/chat-deployment');
    expect(c?.tier).toBe('admin');
    expect(c?.nav?.featureId).toBe('chat-deployment');
    expect(c?.hubTab).toBeUndefined();
  });

  it('collapses the standalone Scheduled chats + Widgets nav once enabled', () => {
    expect(byPath('/scheduled-chats')?.nav?.hiddenWhenFeature).toBe('chat-deployment');
    expect(byPath('/widgets')?.nav?.hiddenWhenFeature).toBe('chat-deployment');
  });
});

describe('ADR 0145 — consoles are isolated by the hub discriminator', () => {
  it('access / models / chat-deployment share no tabs', () => {
    const access = visibleHubRoutes(FEATURES, all, 'access').map(tabIdOf);
    const models = visibleHubRoutes(FEATURES, all, 'models').map(tabIdOf);
    const chat = visibleHubRoutes(FEATURES, all, 'chat-deployment').map(tabIdOf);
    const overlap = (a: string[], b: string[]): string[] => a.filter((x) => b.includes(x));
    expect(overlap(access, models)).toEqual([]);
    expect(overlap(access, chat)).toEqual([]);
    expect(overlap(models, chat)).toEqual([]);
  });
});

describe('ADR 0145 — re-filed destinations', () => {
  it('Channels redirects into the unified chat — ADR 0154 retired the standalone nav', () => {
    // ADR 0154 Phase 3 supersedes ADR 0145 §4: /channels is now a redirect shim
    // (no nav entry) — channels live in the chat Conversations rail.
    const ch = byPath('/channels');
    expect(ch?.tier).toBe('workspace');
    expect(ch?.nav).toBeUndefined();
  });

  it('Work patterns sits in the Operations group (admin-tier)', () => {
    const wp = byPath('/work-patterns');
    expect(wp?.tier).toBe('admin');
    expect(wp?.nav?.group).toBe('Operations');
  });
});
