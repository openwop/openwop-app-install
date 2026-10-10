/**
 * ADR 0785 P2 — the light half of the terminal tab: which terminal a deck tab
 * shows, and where its viewer socket connects. Kept apart from the component so
 * closing a tab (and tests) never load the xterm chunk.
 */
import { config } from '../../client/config.js';

const STORE_PREFIX = 'claude-code:tab:';

/** Which terminal session a deck tab shows (per-browser convenience; the host holds the truth). */
export const tabStore = {
  get(tabId: string): string | null { try { return localStorage.getItem(STORE_PREFIX + tabId); } catch { return null; } },
  set(tabId: string, sessionId: string): void { try { localStorage.setItem(STORE_PREFIX + tabId, sessionId); } catch { /* private mode */ } },
  clear(tabId: string): void { try { localStorage.removeItem(STORE_PREFIX + tabId); } catch { /* private mode */ } },
};

/** The viewer socket URL: straight to the backend origin, never through the CDN. */
export function viewerSocketUrl(path: string, ticket: string, base = config.sseBaseUrl || config.baseUrl, here = window.location.href): string {
  const http = new URL(base, here);
  const root = `${http.origin}${http.pathname.replace(/\/+$/, '')}`.replace(/^http/, 'ws');
  return `${root}${path}?ticket=${encodeURIComponent(ticket)}`;
}

