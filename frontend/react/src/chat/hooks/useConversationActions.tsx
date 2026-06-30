/**
 * useConversationActions — the SHARED per-conversation actions (ADR 0140 parity).
 *
 * Owns the low-frequency conversation actions that BOTH full chat surfaces offer —
 * the standalone `ChatSidebar` (via its `ChatHeader` ⋯ More menu) and each multi-tab
 * `TabSession` (via its per-tab ⋯ menu). Before this, the handlers lived inline in
 * `ChatSidebar` and the multi-tab deck shipped without any of them.
 *
 * It owns:
 *   - `onBranch()` — fork-from-end: mint a child seeded with this conversation's turns
 *     (ADR 0117 Phase 2c), refresh the list, open the child.
 *   - `onBranchFrom(fromSeq)` — fork seeded with the first `fromSeq` turns (Phase 4).
 *   - `onImport(file)` — parse a supported export file → a NEW owned conversation
 *     (ADR 0119), refresh, open it. Best-effort (a bad file → a toast).
 *   - `onExport(format)` — download the transcript as md/json (ADR 0119 Phase 5).
 *   - `onShare()` — mint + copy a public read-only link (ADR 0122), owner-only.
 *   - compare state: `compareOpen` + `openCompare()` / `closeCompare()` (ADR 0117 Phase 3).
 *
 * The SURFACE supplies `refreshList` + `onOpenConversation` so the action lands in the
 * right place: the standalone passes `sessionsCollection.refresh` + `selectConversation`
 * (open in-place), the deck passes `sessions.refresh` + `openTab` (open-or-focus a tab).
 * Behaviour + i18n keys are identical to the old `ChatSidebar` inline handlers.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { branchConversation } from '../../client/chatSessionsClient.js';
import { exportConversation, importConversation, detectImportFormat } from '../../client/chatExportClient.js';
import { listOrgs } from '../../client/promptLibraryClient.js';
import { toast } from '../../ui/toast.js';

export interface UseConversationActionsOptions {
  /** The conversation these actions operate on. */
  sessionId: string;
  /** Refresh the surface's conversation list after a mutation (branch/import). */
  refreshList: () => Promise<void> | void;
  /** Open a conversation on the surface (standalone: select in-place; deck: open-or-focus a tab). */
  onOpenConversation: (sessionId: string) => void | Promise<void>;
}

export interface ConversationActions {
  /** ADR 0117 Phase 2c — branch (fork-from-end), then open the child. */
  onBranch: () => Promise<void>;
  /** ADR 0117 Phase 4 — branch from a specific turn (fromSeq = turns-to-seed). */
  onBranchFrom: (fromSeq: number) => Promise<void>;
  /** ADR 0119 — import a conversation from a supported export file, then open it. */
  onImport: (file: File) => Promise<void>;
  /** ADR 0119 Phase 5 — download the transcript in the chosen format. */
  onExport: (format: 'md' | 'json') => Promise<void>;
  /** ADR 0122 — mint + copy a public read-only link (owner-only). */
  onShare: () => Promise<void>;
  /** ADR 0117 Phase 3 — the read-only side-by-side compare view. */
  compareOpen: boolean;
  openCompare: () => void;
  closeCompare: () => void;
}

export function useConversationActions({ sessionId, refreshList, onOpenConversation }: UseConversationActionsOptions): ConversationActions {
  const { t } = useTranslation('chat');
  const [compareOpen, setCompareOpen] = useState(false);

  // ADR 0117 Phase 2c — branch the conversation (fork-from-end): mint a child seeded
  // with this conversation's turns, refresh the list, and open it via the SAME surface
  // open flow (no new router path). Reuses branchConversation — no parallel data layer.
  const onBranch = useCallback(async () => {
    const child = await branchConversation(sessionId);
    await refreshList();
    void onOpenConversation(child.sessionId);
  }, [sessionId, refreshList, onOpenConversation]);

  // ADR 0117 Phase 4 — branch from a SPECIFIC message: fork seeded with the parent's
  // first `fromSeq` messages (the route bounds-checks fromSeq).
  const onBranchFrom = useCallback(async (fromSeq: number) => {
    const child = await branchConversation(sessionId, fromSeq);
    await refreshList();
    void onOpenConversation(child.sessionId);
  }, [sessionId, refreshList, onOpenConversation]);

  // ADR 0119 — import a conversation from a supported export file → a NEW owned
  // conversation, then open it. Best-effort: a bad/hostile file is rejected server-side.
  const onImport = useCallback(async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text());
      const { sessionId: newId } = await importConversation(detectImportFormat(data), data);
      await refreshList();
      void onOpenConversation(newId);
    } catch { toast.error(t('importFailed')); }
  }, [refreshList, onOpenConversation, t]);

  // ADR 0119 Phase 5 — download the conversation transcript in the chosen format.
  const onExport = useCallback(async (format: 'md' | 'json') => {
    try { await exportConversation(sessionId, format); }
    catch { toast.error(t('exportFailed')); }
  }, [sessionId, t]);

  // ADR 0122 — mint a public read-only link for THIS conversation and copy it.
  // Owner-only is enforced server-side on mint (403 → a clear toast). Lazy-imports the
  // sharing client so this core chat surface keeps no static edge into the sharing feature.
  const onShare = useCallback(async () => {
    try {
      const { createLink, sharedPageUrl } = await import('../../features/sharing/sharingClient.js');
      const orgId = (await listOrgs())[0]?.orgId;
      if (!orgId) { toast.error(t('shareFailed', { defaultValue: 'Could not create a share link.' })); return; }
      const link = await createLink(orgId, { resourceType: 'conversation', resourceId: sessionId });
      const url = sharedPageUrl(link.token);
      try { await navigator.clipboard.writeText(url); toast.success(t('shareCopied', { defaultValue: 'Public link copied to clipboard' })); }
      catch { toast.success(url); }
    } catch (e) {
      const owner = e instanceof Error && /owner/i.test(e.message);
      toast.error(owner ? t('shareOwnerOnly', { defaultValue: 'Only the conversation owner can share it.' }) : t('shareFailed', { defaultValue: 'Could not create a share link.' }));
    }
  }, [sessionId, t]);

  const openCompare = useCallback(() => setCompareOpen(true), []);
  const closeCompare = useCallback(() => setCompareOpen(false), []);

  return { onBranch, onBranchFrom, onImport, onExport, onShare, compareOpen, openCompare, closeCompare };
}
