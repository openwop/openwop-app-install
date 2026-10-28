/**
 * ADR 0960 D3 — which builder store the canvas reads.
 *
 * The builder renders against its singleton (`useBuilderStore`). A read-only run
 * view provides its own isolated instance (`createReadOnlyBuilderStore`) through
 * `CanvasStoreContext`; the canvas and its nodes read through these hooks, so
 * the same canvas paints either store and the builder's behaviour is unchanged
 * (no provider ⇒ the singleton).
 */
import { createContext, useContext } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { useBuilderStore, type BuilderState } from './builderStore.js';

export const CanvasStoreContext = createContext<StoreApi<BuilderState> | null>(null);

/** The store the canvas renders: the provided instance, else the builder's. */
export function useCanvasStoreApi(): StoreApi<BuilderState> {
  return useContext(CanvasStoreContext) ?? useBuilderStore;
}

/** Selector hook over `useCanvasStoreApi()`. */
export function useCanvasStore<T>(selector: (s: BuilderState) => T): T {
  return useStore(useCanvasStoreApi(), selector);
}
