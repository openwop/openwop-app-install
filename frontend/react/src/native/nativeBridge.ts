// Bridge between the web app and an optional native shell (ADR 0181 Phase A).
//
// The SAME `frontend/react` bundle runs in more than one place:
//   1. A normal browser tab (served by the backend / Firebase Hosting).
//   2. (later) Inside a thin desktop shell that loads that exact
//      server-served bundle in a Chromium window (ADR 0181 Phase B).
//   3. (later) Inside a mobile webview loading the same bundle.
//
// In a native shell we can do better than the Web platform: fire an OS-native
// notification and paint a dock / taskbar badge count via a small injected
// bridge object. In the plain-browser case that object is simply absent, so
// every function here degrades to a no-op / `false` and the caller keeps its
// existing Web Notifications path.
//
// Design rules (ADR 0181):
//   * Detection is FEATURE-BASED — an injected `window.openwopNative` global —
//     never a build flag. One bundle, multiple runtimes, decided at runtime.
//   * This module NEVER throws. A broken or outdated shell must not be able to
//     take down the browser notifier that depends on these helpers.
//   * The surface is intentionally tiny and string/number only, so it survives
//     the shell's IPC serialization boundary unchanged.

/** Discriminator so a shell identifies which runtime injected the bridge. */
export type NativeShellKind = 'electron' | 'ios';

/** Parameters for an OS-native notification. All fields are plain strings. */
export interface NativeNotifyParams {
  /** Notification title (the in-app notification's `title`). */
  title: string;
  /** Body text (the in-app notification's `message`). */
  body: string;
  /**
   * Stable de-dupe key (the `notificationId`) so the same row arriving twice
   * (SSE reconnect racing a REST refresh) only surfaces one OS toast — mirrors
   * the Web Notifications `tag`.
   */
  tag?: string;
  /**
   * In-app path the shell should hand back on click (the notification's
   * `actionUrl`), so activating the OS toast resumes the flow. Absent → the
   * click only focuses the app.
   */
  navigatePath?: string;
  /** When true, ask the shell to keep the toast until dismissed (urgent rows). */
  requireInteraction?: boolean;
}

/**
 * The minimal API a native shell injects on `window.openwopNative`. Kept tiny
 * and serialization-safe. Newer shells may add optional members; callers must
 * treat every member as possibly-absent (an older shell).
 */
export interface NativeShellApi {
  /** Discriminator so feature detection is unambiguous. */
  kind: NativeShellKind;
  /** Paint the dock / taskbar unread badge; `0` clears it. */
  setBadgeCount?: (count: number) => void;
  /** Fire an OS notification; resolves `true` when it was actually shown. */
  notify?: (params: NativeNotifyParams) => Promise<boolean>;
  /**
   * Subscribe to OS-notification clicks. The shell hands back the in-app path
   * the notification carried (its `navigatePath`). Returns an unsubscribe fn.
   * An older shell may lack this, in which case clicking a native toast only
   * focuses the app (the shell's own default) and we never navigate.
   */
  onNotificationActivated?: (callback: (path: string) => void) => () => void;
}

declare global {
  interface Window {
    /** Injected by a native shell (ADR 0181). Absent in a plain browser tab. */
    openwopNative?: NativeShellApi;
  }
}

/** Resolve the injected bridge, or `undefined` in a plain browser / SSR. */
function bridge(): NativeShellApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = window.openwopNative;
  // Guard against a malformed injection: require the discriminator.
  if (!api || (api.kind !== 'electron' && api.kind !== 'ios')) return undefined;
  return api;
}

/** True when running inside a recognised native shell. */
export function isNativeShell(): boolean {
  return bridge() !== undefined;
}

/** The shell kind, or `null` in a plain browser. */
export function nativeShellKind(): NativeShellKind | null {
  return bridge()?.kind ?? null;
}

/**
 * Fire an OS notification through the native shell.
 *
 * @returns `true` only when a native shell was present AND it reported the
 *   notification shown. `false` otherwise — the caller should then fall back
 *   to its existing Web Notifications path. Never throws.
 */
export async function nativeNotify(params: NativeNotifyParams): Promise<boolean> {
  const api = bridge();
  if (!api?.notify) return false;
  try {
    return (await api.notify(params)) === true;
  } catch {
    // A broken shell must not break the browser notifier.
    return false;
  }
}

/**
 * Paint the dock / taskbar unread badge. No-op (and never throws) in a plain
 * browser or against a shell too old to expose `setBadgeCount`. `count <= 0`
 * clears the badge.
 */
export function setNativeBadgeCount(count: number): void {
  const api = bridge();
  if (!api?.setBadgeCount) return;
  try {
    api.setBadgeCount(Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
  } catch {
    /* defense-in-depth — a shell IPC failure must not break the store */
  }
}

/**
 * Subscribe to native OS-notification clicks. `callback` receives the in-app
 * path the notification carried. Returns an unsubscribe function. In a plain
 * browser (or a shell lacking activation routing) this is a no-op that returns
 * a no-op unsubscribe, so callers can wire it unconditionally. Never throws.
 */
export function onNativeNotificationActivated(callback: (path: string) => void): () => void {
  const api = bridge();
  if (!api?.onNotificationActivated) return () => {};
  try {
    const unsub = api.onNotificationActivated(callback);
    return typeof unsub === 'function' ? unsub : () => {};
  } catch {
    return () => {};
  }
}
