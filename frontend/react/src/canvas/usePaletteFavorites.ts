/**
 * Canvas framework — palette favorites + recently-used (audit polish P2).
 * A per-device, per-canvas-type view preference persisted to localStorage
 * (the `useViewMode` precedent — no backend surface for a device-local pref;
 * storage failures fall back to in-memory so private mode still works).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PalettePrefs { favorites: string[]; recents: string[] }

const RECENTS_CAP = 8; // the MyndHyve number — enough to be useful, never a wall

const keyFor = (canvasTypeId: string): string => `cv-palette:${canvasTypeId}`;

function load(canvasTypeId: string): PalettePrefs {
  try {
    const raw = localStorage.getItem(keyFor(canvasTypeId));
    if (!raw) return { favorites: [], recents: [] };
    const p = JSON.parse(raw) as Partial<PalettePrefs>;
    return {
      favorites: Array.isArray(p.favorites) ? p.favorites.filter((t): t is string => typeof t === 'string') : [],
      recents: Array.isArray(p.recents) ? p.recents.filter((t): t is string => typeof t === 'string') : [],
    };
  } catch { return { favorites: [], recents: [] }; }
}

function save(canvasTypeId: string, prefs: PalettePrefs): void {
  try { localStorage.setItem(keyFor(canvasTypeId), JSON.stringify(prefs)); } catch { /* private mode — in-memory only */ }
}

export function usePaletteFavorites(canvasTypeId: string): {
  favorites: readonly string[];
  recents: readonly string[];
  isFavorite: (type: string) => boolean;
  toggleFavorite: (type: string) => void;
  noteUsed: (type: string) => void;
} {
  const [prefs, setPrefs] = useState<PalettePrefs>(() => load(canvasTypeId));
  // Re-read when the key changes on a mounted component — otherwise a save
  // after a type switch would write type-A prefs into type-B's key.
  const keyRef = useRef(canvasTypeId);
  useEffect(() => {
    if (keyRef.current === canvasTypeId) return;
    keyRef.current = canvasTypeId;
    setPrefs(load(canvasTypeId));
  }, [canvasTypeId]);

  const toggleFavorite = useCallback((type: string) => {
    setPrefs((p) => {
      const next = p.favorites.includes(type)
        ? { ...p, favorites: p.favorites.filter((t) => t !== type) }
        : { ...p, favorites: [...p.favorites, type] };
      save(canvasTypeId, next);
      return next;
    });
  }, [canvasTypeId]);

  const noteUsed = useCallback((type: string) => {
    setPrefs((p) => {
      const next = { ...p, recents: [type, ...p.recents.filter((t) => t !== type)].slice(0, RECENTS_CAP) };
      save(canvasTypeId, next);
      return next;
    });
  }, [canvasTypeId]);

  const isFavorite = useCallback((type: string) => prefs.favorites.includes(type), [prefs.favorites]);

  return { favorites: prefs.favorites, recents: prefs.recents, isFavorite, toggleFavorite, noteUsed };
}
