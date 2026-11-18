/**
 * ADR 1040 D7 F4 — one feature link in assistant markdown, resolved for THIS
 * viewer. Plain text until (and unless) the feature's resolver answers with a
 * same-origin in-app path; then an in-app router link (never a new tab, never
 * an `href` built from model text).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { safeInAppPath, type ChatLinkResolve } from './lib/chatLinkResolvers.js';

export function ChatFeatureLink({ id, resolve, children }: { id: string; resolve: ChatLinkResolve; children: ReactNode }): JSX.Element {
  const inRouter = useInRouterContext();
  const [route, setRoute] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    setRoute(null);
    void (async () => {
      try {
        const path = safeInAppPath(await resolve(id, { signal: ctl.signal }));
        if (!ctl.signal.aborted && path) setRoute(path);
      } catch {
        /* a failing resolver leaves the text as text */
      }
    })();
    return () => ctl.abort();
  }, [id, resolve]);
  if (!route || !inRouter) return <span>{children}</span>;
  return <Link to={route}>{children}</Link>;
}
