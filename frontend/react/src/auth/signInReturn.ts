/**
 * "Sign in, then come back to the store" — shared by the public /pricing page
 * (#4534) and the feature store's anonymous state (ADR 0820 §7).
 *
 * The header sign-in dialog is opened through the header trigger's own click
 * (`.signin-trigger`, rendered by `auth/SignInButton`), so the same dialog,
 * providers, MFA and error handling run and no auth code is imported into the
 * caller's chunk.
 *
 * The return path survives an OIDC redirect in sessionStorage, with a short
 * expiry so a dismissed dialog can never hijack a much later sign-in. Per-tab,
 * best-effort: blocked storage just means the visitor lands where the provider
 * returns them, signed in. Only an internal store path is ever honoured.
 *
 * ADR 1097 — the public `/start-trial` entry uses the same remembered return, so
 * it is the second allowed destination. The guard is an allowlist of exact
 * paths: the value must resolve SAME-ORIGIN, and its pathname must equal an
 * allowed path (a query is kept). `//evil.example`, `https://…`, backslash and
 * `/marketplace/bundles-lookalike` forms are all refused.
 */
const RETURN_KEY = 'openwop.pricing.returnTo';
const RETURN_TTL_MS = 30 * 60 * 1000;
/** The one place a remembered return may point (the authed feature store). */
export const STORE_URL = '/marketplace/bundles';
/** ADR 1097 — the public trial entry (`/start-trial?plan=<tier>|bundle=<id>`). */
export const START_TRIAL_PATH = '/start-trial';
const RETURN_PATHS: ReadonlySet<string> = new Set([STORE_URL, START_TRIAL_PATH]);

/** `url` as an in-app path (pathname + search) when it is same-origin and its
 *  pathname is an allowed return; otherwise null. */
export function safeReturnPath(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//') || /[\\\s]/.test(url)) return null;
  try {
    const origin = window.location.origin;
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return null;
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (!RETURN_PATHS.has(path)) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch { return null; }
}

export function rememberReturn(url: string): void {
  try { window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ url, at: Date.now() })); } catch { /* storage blocked */ }
}

/** The pending return path (only an allowed in-app path), cleared as it is read. */
export function takeReturn(now = Date.now()): string | null {
  try {
    const raw = window.sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(RETURN_KEY);
    const v = JSON.parse(raw) as { url?: unknown; at?: unknown };
    if (typeof v.url !== 'string' || typeof v.at !== 'number' || now - v.at > RETURN_TTL_MS) return null;
    return safeReturnPath(v.url);
  } catch { return null; }
}

/** Click the header's sign-in trigger. `false` = this host renders no sign-in UI. */
export function openHeaderSignIn(): boolean {
  const trigger = document.querySelector<HTMLButtonElement>('.signin-trigger');
  if (!trigger) return false;
  trigger.click();
  return true;
}
