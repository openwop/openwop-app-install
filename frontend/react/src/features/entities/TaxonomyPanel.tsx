/**
 * Taxonomy manager (ADR 0386 Phase 2) — taxonomies with ordered, optionally
 * nested terms. Rendered inside the Entities page rail.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../ui/toast.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { confirm } from '../../ui/confirm.js';
import { PlusIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon } from '../../ui/icons/index.js';
import {
  createTaxonomy,
  createTerm,
  deleteTaxonomy,
  deleteTerm,
  listTaxonomies,
  listTerms,
  reorderTerms,
  type Taxonomy,
  type Term,
} from './entitiesClient.js';

/** `canManage` (ADR 0847 / `ENT3UX-2`) — the viewer may author taxonomies and terms;
 *  without it the panel is read-only and offers no write that would 403. */
export function TaxonomyPanel({ canManage }: { canManage: boolean }): JSX.Element {
  const { t } = useTranslation('entities');
  const [taxonomies, setTaxonomies] = useState<Taxonomy[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [newTax, setNewTax] = useState('');
  const [newTerm, setNewTerm] = useState('');
  const [newTermParent, setNewTermParent] = useState('');
  const [busy, setBusy] = useState(false);
  // `ENT3UX-4` (round-1 `ENT-G1`) — a failed read is an error state, not an empty list.
  const [listFailed, setListFailed] = useState(false);
  const [termsFailed, setTermsFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = (await listTaxonomies()).filter((x) => !x.projectId); // root namespace (ENT3CD-4)
      setTaxonomies(list);
      setListFailed(false);
      if (list.length > 0 && !list.some((x) => x.name === selected)) setSelected(list[0]?.name ?? null);
      if (list.length === 0) setSelected(null);
    } catch {
      setTaxonomies([]);
      setListFailed(true);
    }
  }, [selected]);

  const refreshTerms = useCallback(async (name: string) => {
    setTerms(null);
    setTermsFailed(false);
    try {
      setTerms(await listTerms(name));
    } catch {
      setTerms([]);
      setTermsFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected) void refreshTerms(selected);
    else setTerms(null);
  }, [selected, refreshTerms]);

  const onCreateTaxonomy = useCallback(async () => {
    if (!newTax.trim()) return;
    setBusy(true);
    try {
      await createTaxonomy(newTax.trim());
      setNewTax('');
      await refresh();
      setSelected(newTax.trim().toLowerCase());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [newTax, refresh]);

  const onDeleteTaxonomy = useCallback(async () => {
    if (!selected) return;
    const ok = await confirm({ title: t('deleteTaxonomyTitle'), body: t('deleteTaxonomyBody', { name: selected }) });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteTaxonomy(selected);
      setSelected(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, refresh, t]);

  const onCreateTerm = useCallback(async () => {
    if (!selected || !newTerm.trim()) return;
    setBusy(true);
    try {
      await createTerm(selected, newTerm.trim(), newTermParent ? { parentId: newTermParent } : undefined);
      setNewTerm('');
      setNewTermParent('');
      await refreshTerms(selected);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, newTerm, newTermParent, refreshTerms]);

  const onDeleteTerm = useCallback(
    async (term: Term) => {
      if (!selected) return;
      const ok = await confirm({ title: t('deleteTermTitle'), body: t('deleteTermBody', { label: term.label }) });
      if (!ok) return;
      try {
        await deleteTerm(selected, term.slug);
        toast.success(t('termDeleted'));
        await refreshTerms(selected);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [selected, refreshTerms, t],
  );

  const onMove = useCallback(
    async (index: number, dir: -1 | 1) => {
      if (!selected || !terms) return;
      const target = index + dir;
      if (target < 0 || target >= terms.length) return;
      const slugs = terms.map((x) => x.slug);
      const [moved] = slugs.splice(index, 1);
      if (moved === undefined) return;
      slugs.splice(target, 0, moved);
      try {
        setTerms(await reorderTerms(selected, slugs));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [selected, terms],
  );

  return (
    <div className="surface-card u-p-3 u-mt-3">
      <div className="u-flex u-justify-between u-items-center u-mb-2">
        <h2 className="u-fs-13 u-fw-600 u-m-0">{t('taxonomiesHeading')}</h2>
      </div>
      {canManage ? <div className="u-flex u-gap-2 u-mb-2">
        <input
          className="ui-input"
          placeholder={t('taxonomyNamePh')}
          aria-label={t('taxonomyNamePh')}
          value={newTax}
          onChange={(e) => setNewTax(e.target.value)}
        />
        <Button variant="quiet" size="sm" onClick={() => void onCreateTaxonomy()} disabled={busy} aria-label={t('addTaxonomy')}>
          <PlusIcon size={14} />
        </Button>
      </div> : null}
      {listFailed ? (
        <Notice variant="error" announce={t('taxonomiesLoadFailed')}>
          {t('taxonomiesLoadFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={() => void refresh()}>{t('retry')}</Button>
        </Notice>
      ) : taxonomies === null ? (
        <SkeletonRows rows={2} columns={['70%']} />
      ) : taxonomies.length === 0 ? (
        <p className="u-fs-12 muted">{t('noTaxonomiesHint')}</p>
      ) : (
        <>
          <div className="u-flex u-gap-1 u-flex-wrap u-mb-2">
            {taxonomies.map((x) => (
              <button
                key={x.taxonomyId}
                type="button"
                className={x.name === selected ? 'chip chip--accent' : 'chip'}
                aria-current={x.name === selected ? 'true' : undefined}
                onClick={() => setSelected(x.name)}
              >
                {x.displayName}
              </button>
            ))}
          </div>
          {selected ? (
            <div>
              {canManage ? <div className="u-flex u-gap-2 u-mb-2">
                <input
                  className="ui-input"
                  placeholder={t('termSlugPh')}
                  aria-label={t('termSlugPh')}
                  value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)}
                />
                <select
                  className="ui-input"
                  aria-label={t('termParentPh')}
                  value={newTermParent}
                  onChange={(e) => setNewTermParent(e.target.value)}
                >
                  <option value="">{t('termNoParent')}</option>
                  {(terms ?? []).map((x) => (
                    <option key={x.termId} value={x.termId}>{x.label}</option>
                  ))}
                </select>
                <Button variant="quiet" size="sm" onClick={() => void onCreateTerm()} disabled={busy} aria-label={t('addTerm')}>
                  <PlusIcon size={14} />
                </Button>
              </div> : null}
              {termsFailed ? (
                <Notice variant="error" announce={t('termListLoadFailed')}>
                  {t('termListLoadFailed')}{' '}
                  <Button variant="quiet" size="sm" onClick={() => void refreshTerms(selected)}>{t('retry')}</Button>
                </Notice>
              ) : null}
              {terms === null ? <SkeletonRows rows={2} columns={['60%']} /> : null}
              <ul className="u-list-none u-p-0 u-m-0">
                {(terms ?? []).map((x, i) => (
                  <li key={x.termId} className="u-flex u-items-center u-gap-2 u-mb-1">
                    <span className={x.parentId ? 'u-fs-12 u-ml-3' : 'u-fs-12'}>{x.label}</span>
                    {canManage ? <span className="u-flex u-gap-1 u-ml-auto">
                      <Button variant="quiet" size="sm" onClick={() => void onMove(i, -1)} aria-label={t('moveUp')}>
                        <ChevronUpIcon size={12} />
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => void onMove(i, 1)} aria-label={t('moveDown')}>
                        <ChevronDownIcon size={12} />
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => void onDeleteTerm(x)} aria-label={t('deleteTerm')}>
                        <TrashIcon size={12} />
                      </Button>
                    </span> : null}
                  </li>
                ))}
              </ul>
              {canManage ? (
                <Button variant="quiet" size="sm" className="u-mt-1" onClick={() => void onDeleteTaxonomy()} disabled={busy}>
                  {t('deleteTaxonomy')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
