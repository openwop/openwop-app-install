/**
 * The ONE host for the re-authentication dialog (`auth/reauth.ts`). Mount it
 * beside `<ConfirmRoot>` in each shell. It renders nothing until a
 * `withRecentLogin` caller hits `auth/requires-recent-login`; the dialog body
 * and the Firebase calls behind it load only then.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { registerReauthPresenter } from './reauth.js';

const ReauthDialog = lazy(() => import('./ReauthDialog.js').then((m) => ({ default: m.ReauthDialog })));

export function ReauthRoot(): JSX.Element | null {
  const [settle, setSettle] = useState<((ok: boolean) => void) | null>(null);
  useEffect(() => registerReauthPresenter((next) => setSettle(() => next)), []);
  if (!settle) return null;
  const done = (ok: boolean): void => { settle(ok); setSettle(null); };
  return (
    <Suspense fallback={null}>
      <ReauthDialog onDone={done} />
    </Suspense>
  );
}
