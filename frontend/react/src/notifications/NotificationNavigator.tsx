/**
 * NotificationNavigator (CMNT-UX-4) — renders nothing; registers the app shell's
 * react-router navigator with `notificationStore`.
 *
 * WHY THIS EXISTS. `notificationStore` is a plain module (no React context), so
 * its desktop-toast / native-shell click handler navigated with a raw
 * `window.history.pushState`. React Router does not observe `pushState` — it
 * listens for `popstate` — so an OS-toast click changed the address bar and the
 * SPA never re-rendered. The failure is silent and it is worst on a SAME-ROUTE
 * deep-link (`/comments?resourceId=A` → `/comments?resourceId=B`), where the user
 * is left looking at the previous thread.
 *
 * Mounted once in the authed shell. The store keeps its `pushState` fallback for
 * the window before this mounts and for the shell-less public routes.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerActionUrlNavigator } from './notificationStore.js';

export function NotificationNavigator(): null {
  const navigate = useNavigate();
  useEffect(() => {
    registerActionUrlNavigator((path) => navigate(path));
    return () => registerActionUrlNavigator(null);
  }, [navigate]);
  return null;
}
