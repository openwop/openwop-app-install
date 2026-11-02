/**
 * Recent-login recovery: when Firebase refuses a sensitive change with
 * `auth/requires-recent-login`, ask the person to confirm it is them in ONE
 * app-level dialog (`<ReauthRoot>`, mounted beside `<ConfirmRoot>`), then retry
 * the change once — instead of telling them to sign out and back in.
 *
 *   await withRecentLogin(() => unenrollMfaFactor(uid));
 *
 * SDK-free on purpose: it rides the entry chunk with every caller, while the
 * dialog and the Firebase re-authentication calls load only when it opens.
 */

/** The person dismissed the re-authentication dialog. Callers treat it as a
 *  quiet no-op: they asked to stop, so there is nothing to report. */
export class ReauthCancelledError extends Error {
  constructor() {
    super('Re-authentication was cancelled.');
    this.name = 'ReauthCancelledError';
  }
}

/** Whether `err` is Firebase's "this change needs a recent sign-in" refusal. */
export function isRequiresRecentLogin(err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === 'auth/requires-recent-login') return true;
  return err instanceof Error && err.message.includes('auth/requires-recent-login');
}

export type ReauthOutcome = 'reauthenticated' | 'cancelled' | 'unavailable';

type Presenter = (settle: (ok: boolean) => void) => void;

let presenter: Presenter | null = null;
let inflight: Promise<ReauthOutcome> | null = null;

/** Register the dialog host. Returns an unregister that only clears its own
 *  registration (a later-mounted host stays live). */
export function registerReauthPresenter(fn: Presenter): () => void {
  presenter = fn;
  return () => { if (presenter === fn) presenter = null; };
}

/** Open the re-authentication dialog. Concurrent requests share one dialog.
 *  `'unavailable'` when no host is mounted (SSR / unit tests / a bare shell). */
export function requestReauth(): Promise<ReauthOutcome> {
  if (inflight) return inflight;
  const present = presenter;
  if (!present) return Promise.resolve('unavailable');
  inflight = new Promise<ReauthOutcome>((resolve) => {
    present((ok) => resolve(ok ? 'reauthenticated' : 'cancelled'));
  }).finally(() => { inflight = null; });
  return inflight;
}

/**
 * Run `action`; if Firebase demands a recent sign-in, re-authenticate in place
 * and retry it ONCE. A second refusal propagates as-is (never a loop), a
 * cancelled dialog throws `ReauthCancelledError`, and with no dialog host the
 * original error propagates.
 */
export async function withRecentLogin<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!isRequiresRecentLogin(err)) throw err;
    const outcome = await requestReauth();
    if (outcome === 'unavailable') throw err;
    if (outcome === 'cancelled') throw new ReauthCancelledError();
  }
  return await action();
}
