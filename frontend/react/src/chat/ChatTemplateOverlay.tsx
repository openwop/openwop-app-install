/**
 * The chat's template overlay (the picker-templates ADR; extends ADR 0163).
 *
 * Picking a template in the `/` picker opens THIS: the shared builder
 * `TemplatePreflightModal` over the chat, or the shared `TemplateGalleryDialog`
 * for "Browse all templates…" (DESIGN.md §4 rule 14: a picker is a
 * self-contained detour; you pick and come straight back). Nothing here is a
 * new surface: the preflight collects the inputs, connections and client, and
 * Confirm calls the ONE instantiate path (`instantiateChain`, ADR 0959 P0).
 *
 * After the copy is minted the chat refreshes its workflow list and puts
 * `/<new-slug> ` in the composer. `SlashInputsPanel` then collects run inputs
 * and the person presses Enter: the run is of the OWNED copy, never the chain.
 *
 * A template the person already owns a copy of (`fromChainId`) is marked
 * "You have a copy" in the gallery, and its preflight's primary action says
 * "Add another copy": the picker shows the owned copy in place of the template
 * row, so the gallery is where a deliberate second copy is made (ADR 0163 R2
 * mints a new copy on every confirm).
 *
 * Import rule: the builder must stay out of the chat's module graph, so every
 * builder module is reached through a dynamic `import()`.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TemplateGalleryDialog, type TemplateItem } from '../ui/TemplateGallery.js';
import { toast } from '../ui/toast.js';
import { SyncFailureError } from '../client/config.js';
import { bidiIsolate } from '../lib/bidi.js';
import { useAllFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import type { ChainTemplate } from '../builder/persistence/backendStore.js';
import { listWorkflowMentions, refreshWorkflowMentionCache } from './lib/workflowMentions.js';
import {
  cachedChainTemplate,
  listCachedChainTemplates,
  refreshChainTemplateCache,
  templateAvailable,
  type TemplateIntent,
} from './lib/slashTemplates.js';

const TemplatePreflightModal = lazy(() =>
  import('../builder/TemplatePreflightModal.js').then((m) => ({ default: m.TemplatePreflightModal })),
);

type View = { mode: 'preflight'; chainId: string } | { mode: 'gallery' };

export function ChatTemplateOverlay({
  intent,
  onClose,
  onInstantiated,
}: {
  intent: TemplateIntent;
  /** Dismissed without adding anything. */
  onClose: () => void;
  /** A copy was added; `composerText` goes in the composer (`/<slug> `, after
   *  any `@agent ` prefix the picker preserved). */
  onInstantiated: (composerText: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  const { t: tb } = useTranslation('builder');
  const [view, setView] = useState<View>(() =>
    intent.kind === 'open-preflight' ? { mode: 'preflight', chainId: intent.chainId } : { mode: 'gallery' },
  );
  const prefix = intent.prefix;

  // The catalog: the picker's cache when warm, refreshed once on open so the
  // gallery is current and a cold preflight can find its chain.
  const [catalog, setCatalog] = useState<readonly ChainTemplate[] | null>(() => {
    const cached = listCachedChainTemplates();
    return cached.length > 0 ? cached : null;
  });
  const [catalogFailed, setCatalogFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void refreshChainTemplateCache().then((ok) => {
      if (!live) return;
      const rows = listCachedChainTemplates();
      if (ok || rows.length > 0) setCatalog(rows);
      setCatalogFailed(!ok && rows.length === 0);
    });
    return () => { live = false; };
  }, []);

  // Chains the person already owns a copy of, read once on open.
  const ownedChains = useMemo(
    () => new Set(listWorkflowMentions().flatMap((e) => (e.fromChainId ? [e.fromChainId] : []))),
    [],
  );

  const { byId } = useAllFeatureAccess();
  const galleryItems = useMemo<TemplateItem[] | null>(() => {
    if (catalog === null) return null;
    return catalog
      .filter((c) => templateAvailable(c, (id) => byId[id]?.enabled === true))
      .map((c) => {
        const nodeCount = c.requirements?.nodeCount;
        const meta = [
          ...(typeof nodeCount === 'number' ? [t('workflowNodeCount', { count: nodeCount })] : []),
          ...(ownedChains.has(c.chainId) ? [t('templateYouHaveACopy')] : []),
        ];
        return {
          id: c.chainId,
          // Pack-authored text is bidi-isolated before it meets app chrome.
          label: bidiIsolate(c.label),
          ...(c.description ? { description: bidiIsolate(c.description) } : {}),
          ...(c.category ? { category: bidiIsolate(c.category) } : {}),
          ...(meta.length > 0 ? { meta } : {}),
        };
      });
  }, [catalog, byId, t, ownedChains]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preflightChain = view.mode === 'preflight'
    ? (catalog?.find((c) => c.chainId === view.chainId) ?? cachedChainTemplate(view.chainId) ?? null)
    : null;

  // A preflight for a chain the catalog no longer lists (removed, or now off
  // for this caller) closes with a reason instead of hanging open blank.
  const missingChain = view.mode === 'preflight' && catalog !== null && preflightChain === null;
  useEffect(() => {
    if (!missingChain) return;
    toast.error(t('templateNotFound'));
    onClose();
  }, [missingChain, onClose, t]);

  async function confirm(chain: ChainTemplate, params: Record<string, unknown>, clientOrgId?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const [{ instantiateChain }, { fromChainNotices }] = await Promise.all([
        import('../builder/persistence/backendStore.js'),
        import('../builder/fromChainNotices.js'),
      ]);
      const out = await instantiateChain(chain.chainId, params, clientOrgId);
      // Incomplete steps, unfilled params and missing nodes are said out loud,
      // exactly as the builder's "Use template" says them.
      for (const note of fromChainNotices(out, tb)) toast.warning(note);
      if (out.pinMismatches?.length) {
        toast.warning(tb('templateVersionMismatch', {
          count: out.pinMismatches.length,
          nodes: out.pinMismatches.map((m) => tb('templateVersionMismatchItem', { label: m.label, pinned: m.pinned, installed: m.installed })).join(', '),
        }));
      }
      await refreshWorkflowMentionCache();
      const entry = listWorkflowMentions().find((e) => e.workflowId === out.workflowId);
      if (entry) {
        toast.success(t('templateAddedToComposer', { name: entry.displayName }));
        onInstantiated(`${prefix}/${entry.slug} `);
      } else {
        // Minted, but the list refresh did not see it yet: say so rather than
        // insert a slug the submit path cannot resolve.
        toast.info(t('templateAddedNotListed', { name: chain.label }));
        onInstantiated(prefix);
      }
    } catch (err) {
      // The builder's own mapping: a view-only member and a disabled pack each
      // need a different next step than "try again".
      setError(
        err instanceof SyncFailureError && err.status === 403 && err.reason === 'forbidden_scope'
          ? tb('templateInstantiateReadOnly')
          : err instanceof SyncFailureError && err.status === 403 && err.reason === 'forbidden'
            ? tb('templateInstantiateDisabledPack')
            : tb('templateInstantiateError'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (view.mode === 'gallery') {
    return (
      <TemplateGalleryDialog
        title={t('templateGalleryTitle')}
        items={galleryItems}
        failed={catalogFailed}
        onUse={(id) => { setError(null); setView({ mode: 'preflight', chainId: id }); }}
        emptyTitle={t('templateGalleryEmptyTitle')}
        emptyBody={t('templateGalleryEmptyBody')}
        onClose={onClose}
      />
    );
  }

  if (!preflightChain) return null; // the catalog is still loading
  return (
    <Suspense fallback={null}>
      <TemplatePreflightModal
        chain={preflightChain}
        busy={busy}
        error={error}
        onConfirm={(params, clientOrgId) => { void confirm(preflightChain, params, clientOrgId); }}
        {...(ownedChains.has(preflightChain.chainId) ? { confirmLabel: t('templateAddAnotherCopy') } : {})}
        onClose={onClose}
      />
    </Suspense>
  );
}
