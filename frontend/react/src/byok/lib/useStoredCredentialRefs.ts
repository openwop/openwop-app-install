/** Name-only saved-key inventory shared by run options and feature-owned actions.
 * No secret values, default selection or credential configuration live here. */
import { useEffect, useRef, useState } from 'react';
import { onAuthChange } from '../../client/config.js';
import { listStoredRefs } from './byokClient.js';

/** The existing Run options presentation rule; never treats google-vertex as google. */
export function refsForExactProviders(refs: readonly string[], providers: readonly string[]): string[] {
  return refs.filter(ref => {
    const body = ref.startsWith('byok:') ? ref.slice(5) : ref;
    return providers.some(id => body === id || body.startsWith(`${id}:`));
  });
}

export function useStoredCredentialRefs({ enabled, scopeKey = '', onInvalidate }: {
  enabled: boolean;
  scopeKey?: string;
  onInvalidate?: () => void;
}) {
  const [refs, setRefs] = useState<readonly string[] | undefined>();
  const [failedGeneration, setFailedGeneration] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const loadedGeneration = useRef(-1);
  const scope = useRef(scopeKey);
  const invalidateCallback = useRef(onInvalidate);
  invalidateCallback.current = onInvalidate;
  // Make the previous scope unverified before effects/old submit closures run.
  if (scope.current !== scopeKey) {
    scope.current = scopeKey;
    generation.current += 1;
    loadedGeneration.current = -1;
  }
  useEffect(() => {
    const unsubscribe = onAuthChange(() => {
      generation.current += 1;
      loadedGeneration.current = -1;
      setRefs(undefined);
      setFailedGeneration(null);
      invalidateCallback.current?.();
      setReload(n => n + 1);
    });
    return () => { generation.current += 1; loadedGeneration.current = -1; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const current = ++generation.current;
    let live = true;
    setFailedGeneration(null);
    setRefs(undefined);
    listStoredRefs().then(list => {
      if (live && current === generation.current) {
        loadedGeneration.current = current;
        setRefs(list);
      }
    }, () => { if (live && current === generation.current) setFailedGeneration(current); });
    return () => { live = false; generation.current += 1; };
  }, [enabled, scopeKey, reload]);
  const verified = loadedGeneration.current === generation.current;
  return {
    refs: verified ? refs : undefined,
    failed: failedGeneration === generation.current,
    pending: enabled && !verified,
    retry: () => setReload(n => n + 1),
    capture: () => generation.current,
    isCurrent: (captured: number) => captured === generation.current,
    // Read synchronously at submit too: an auth event can precede rerender.
    isVerified: () => loadedGeneration.current === generation.current,
  };
}
