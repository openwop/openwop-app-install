/**
 * React binding for the storage subject (ADR 0434 / IDN-3).
 *
 * Components that render user-authored `content` (chat threads, prompts, builder
 * drafts) call this to (a) re-render when the subject settles or changes, and
 * (b) tell "auth hasn't resolved yet" apart from "resolved, anonymous" so they
 * can show a skeleton instead of momentarily-empty content during the boot
 * window. Plain non-React modules keep calling `getStorageSubject()` unchanged.
 */
import { useSyncExternalStore } from 'react';
import {
  PENDING_SUBJECT,
  storageSubjectSnapshot,
  subscribeStorageSubject,
} from './storage.js';

export type StorageSubjectState =
  | { status: 'pending' }
  | { status: 'anonymous' }
  | { status: 'user'; subject: string };

export function useStorageSubject(): StorageSubjectState {
  const snapshot = useSyncExternalStore(
    subscribeStorageSubject,
    storageSubjectSnapshot,
    // Server/prerender snapshot: treat as pending — never guess an identity.
    () => PENDING_SUBJECT,
  );
  if (snapshot === PENDING_SUBJECT) return { status: 'pending' };
  if (snapshot === null) return { status: 'anonymous' };
  return { status: 'user', subject: snapshot };
}
