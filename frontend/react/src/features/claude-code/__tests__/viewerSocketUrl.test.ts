/**
 * ADR 0785 P2 — the viewer socket goes STRAIGHT to the backend origin (the CDN
 * does not carry WebSockets), the same reason collab uses `sseBaseUrl`.
 */
import { describe, it, expect } from 'vitest';
import { viewerSocketUrl } from '../terminalTabStore.js';

describe('viewerSocketUrl', () => {
  it('an absolute run.app base ⇒ wss to that origin, with the ticket encoded', () => {
    expect(viewerSocketUrl('/host/openwop-app/claude-code/terminal/cct_1', 'a.b+c', 'https://be-123.a.run.app', 'https://app.openwop.dev/chat'))
      .toBe('wss://be-123.a.run.app/host/openwop-app/claude-code/terminal/cct_1?ticket=a.b%2Bc');
  });
  it('a relative base (dev) ⇒ ws on the page origin, keeping the base path', () => {
    expect(viewerSocketUrl('/host/openwop-app/claude-code/terminal/cct_1', 't', '/api', 'http://localhost:5173/chat'))
      .toBe('ws://localhost:5173/api/host/openwop-app/claude-code/terminal/cct_1?ticket=t');
  });
});
