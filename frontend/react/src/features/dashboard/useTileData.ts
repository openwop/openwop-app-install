/**
 * useTileData (ADR 0377 Wave 1) — the caller-scoped sibling of `useOrgResource`:
 * one fetch on mount with a live-guard, collapsed to loading/error/ready so a
 * tile never throws to the grid. Tiles whose client needs an orgId use
 * `useOrgResource`; everything else uses this.
 */
import { useEffect, useState } from 'react';

export type TileDataStatus = 'loading' | 'error' | 'ready';

export interface TileData<T> {
  status: TileDataStatus;
  data: T | null;
}

export function useTileData<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): TileData<T> {
  const [state, setState] = useState<TileData<T>>({ status: 'loading', data: null });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading', data: null });
    fetcher()
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch(() => { if (live) setState({ status: 'error', data: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher identity varies per render; deps is the tile's explicit trigger list
  }, deps);

  return state;
}
