/**
 * ADR 0139 Phase 4 — the Menu-settings editor (admin surface).
 *
 * Edits one overlay layer at a time — the caller's personalization ("My layout")
 * or the shared workspace default ("Workspace default", superadmin). The display
 * groups every editable nav item by its EFFECTIVE menu + header (so it includes
 * items the layer has hidden — you can re-show them); editing writes sparse
 * overrides into the active layer and saves via the NavConfig provider.
 *
 * Control-based (menu + header dropdowns + a visibility toggle + header CRUD) —
 * fully keyboard-accessible. Per-item drag-reordering is deferred (ADR 0139
 * § correction); items keep their declared order within a header.
 *
 * @see docs/adr/0139-configurable-navigation-menu.md
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FEATURES, GROUP_LABEL_KEYS, groupRank } from '../../chrome/features.js';
import type { FeatureTier } from '../../chrome/featureTypes.js';
import { useNavConfig } from '../../chrome/navConfig/NavConfigProvider.js';
import { mergeLayers, nextHeaderId, isCustomId } from '../../chrome/navConfig/resolveNav.js';
import { EMPTY_MENU_CONFIG, EMPTY_MENU_CONFIG_BUNDLE, type HeaderDef, type ItemOverride, type MenuConfig } from '../../chrome/navConfig/types.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SelectField, TextField, CheckboxField } from '../../ui/Field.js';
import { IconButton } from '../../ui/IconButton.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { PlusIcon, TrashIcon, LockIcon, SettingsIcon } from '../../ui/icons/index.js';

type Scope = 'user' | 'tenant';
const EDIT_TIERS: FeatureTier[] = ['workspace', 'admin'];

interface EditableItem {
  path: string;
  label: string;
  declaredTier: FeatureTier;
  declaredGroup: string;
  alwaysOn: boolean;
  featureId?: string;
}

export function MenuSettingsPage(): JSX.Element {
  const { t } = useTranslation('navigation-settings');
  const { t: tn } = useTranslation('nav');
  const { bundle, loading, saveTenant, saveUser } = useNavConfig();
  const isVisible = useFeatureVisible();

  const [scope, setScope] = useState<Scope>('user');
  const [working, setWorking] = useState<MenuConfig>(EMPTY_MENU_CONFIG);
  const [saving, setSaving] = useState(false);

  // (Re)seed the working copy from the active layer whenever scope or the
  // fetched bundle changes.
  useEffect(() => {
    setWorking(scope === 'tenant' ? bundle.tenant : bundle.user);
  }, [scope, bundle]);

  const baseline = scope === 'tenant' ? bundle.tenant : bundle.user;
  const dirty = useMemo(() => JSON.stringify(working) !== JSON.stringify(baseline), [working, baseline]);

  // The effective config used for DISPLAY: for the user layer, the tenant default
  // shows through beneath the working personalization.
  const merged = useMemo<MenuConfig>(
    () => (scope === 'tenant' ? working : mergeLayers(bundle.tenant, working)),
    [scope, working, bundle.tenant],
  );

  // Every nav item the caller could place (declared nav, in an editable tier,
  // and either always-on or an enabled feature — a disabled feature can't show).
  const items = useMemo<EditableItem[]>(() => {
    const out: EditableItem[] = [];
    for (const f of FEATURES) {
      if (!f.nav) continue;
      if (f.tier !== 'workspace' && f.tier !== 'admin') continue;
      if (f.nav.featureId && !isVisible(f.nav.featureId)) continue;
      out.push({
        path: f.path,
        label: f.nav.labelKey ? tn(f.nav.labelKey, { defaultValue: f.nav.label }) : f.nav.label,
        declaredTier: f.tier,
        declaredGroup: f.nav.group,
        alwaysOn: !f.nav.featureId,
        ...(f.nav.featureId ? { featureId: f.nav.featureId } : {}),
      });
    }
    return out;
  }, [isVisible, tn]);

  const effTier = (it: EditableItem): FeatureTier => merged.items[it.path]?.tier ?? it.declaredTier;
  const effGroup = (it: EditableItem): string => {
    const want = merged.items[it.path]?.group;
    if (want && (want === it.declaredGroup || !isCustomId(want) || merged.headers.some((h) => h.id === want))) return want;
    return it.declaredGroup;
  };
  const isHidden = (it: EditableItem): boolean => !it.alwaysOn && merged.items[it.path]?.hidden === true;

  const labelForHeader = (id: string): string => {
    const h = merged.headers.find((x) => x.id === id);
    if (h?.label) return h.label;
    return tn(GROUP_LABEL_KEYS[id] ?? '', { defaultValue: id });
  };

  // The selectable headers for a tier: built-in groups any item declares there +
  // custom headers assigned to it, ordered like the rail.
  const headersForTier = (tier: FeatureTier): { id: string; label: string }[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };
    for (const it of items) if (effTier(it) === tier) add(effGroup(it));
    for (const h of merged.headers) if (h.tier === tier) add(h.id);
    ids.sort((a, b) => (merged.headers.find((h) => h.id === a)?.order ?? groupRank(a)) - (merged.headers.find((h) => h.id === b)?.order ?? groupRank(b)));
    return ids.map((id) => ({ id, label: labelForHeader(id) }));
  };

  // ── mutations on the active layer ──────────────────────────────────────────
  // A patch may carry `undefined` to CLEAR a field (back to the declared default).
  type ItemPatch = { tier?: FeatureTier | undefined; group?: string | undefined; hidden?: boolean | undefined };
  const patchItem = (path: string, patch: ItemPatch) => {
    setWorking((w) => {
      const m: ItemPatch = { ...w.items[path], ...patch };
      const clean: ItemOverride = {};
      if (m.tier !== undefined) clean.tier = m.tier;
      if (m.group !== undefined) clean.group = m.group;
      if (m.hidden !== undefined) clean.hidden = m.hidden;
      const items2 = { ...w.items };
      if (Object.keys(clean).length === 0) delete items2[path];
      else items2[path] = clean;
      return { ...w, items: items2 };
    });
  };

  const addHeader = (tier: FeatureTier, rawLabel: string) => {
    const label = rawLabel.trim();
    if (!label) return;
    setWorking((w) => ({
      ...w,
      headers: [...w.headers, { id: nextHeaderId(w.headers.map((h) => h.id)), tier, label, custom: true }],
    }));
  };

  const renameHeader = (id: string, tier: FeatureTier, label: string) => {
    setWorking((w) => {
      const existing = w.headers.find((h) => h.id === id);
      const headers = existing
        ? w.headers.map((h) => (h.id === id ? { ...h, label } : h))
        : [...w.headers, { id, tier, label } as HeaderDef];
      return { ...w, headers };
    });
  };

  const removeHeader = async (id: string) => {
    if (!(await confirm({ title: t('removeHeaderConfirm'), confirmLabel: t('remove'), danger: true }))) return;
    setWorking((w) => {
      const items2 = { ...w.items };
      // reassign items pinned to this header back to their declared group
      for (const [path, ov] of Object.entries(items2)) {
        if (ov.group === id) {
          const rest: ItemOverride = { ...ov };
          delete rest.group;
          if (Object.keys(rest).length === 0) delete items2[path];
          else items2[path] = rest;
        }
      }
      return { ...w, items: items2, headers: w.headers.filter((h) => h.id !== id) };
    });
  };

  const onSave = async () => {
    setSaving(true);
    try {
      if (scope === 'tenant') await saveTenant(working);
      else await saveUser(working);
      toast.success(t('saved'));
    } catch (err) {
      const msg = String(err);
      toast.error(scope === 'tenant' && /forbidden|403/.test(msg) ? t('tenantForbidden') : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    if (!(await confirm({ title: t('resetConfirm'), confirmLabel: t('reset'), danger: true }))) return;
    setSaving(true);
    try {
      if (scope === 'tenant') await saveTenant(EMPTY_MENU_CONFIG);
      else await saveUser(EMPTY_MENU_CONFIG);
      setWorking(EMPTY_MENU_CONFIG);
      toast.success(t('resetDone'));
    } catch (err) {
      const msg = String(err);
      toast.error(scope === 'tenant' && /forbidden|403/.test(msg) ? t('tenantForbidden') : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const tierLabel = (tier: FeatureTier): string => (tier === 'workspace' ? t('mainMenu') : t('adminMenu'));

  // First load: the bundle seeds from EMPTY config, so show a busy cue until the
  // real config arrives (rather than flashing the empty editor).
  if (loading && bundle === EMPTY_MENU_CONFIG_BUNDLE) {
    return <StateCard loading title={t('loading')} />;
  }

  return (
    <div className="u-flex u-flex-col u-gap-4">
      <PageHeader
        eyebrow={tn('groupPlatform', { defaultValue: 'Platform' })}
        title={t('title')}
        lede={t('lede')}
        actions={
          <div className="u-flex u-items-center u-gap-2">
            <button type="button" className="secondary btn-sm" onClick={() => void onReset()} disabled={saving}>{t('reset')}</button>
            <button type="button" className="primary btn-sm" onClick={() => void onSave()} disabled={saving || !dirty}>
              {saving ? t('saving') : t('save')}
            </button>
          </div>
        }
      />

      {/* Scope selector — a single-select toggle group (NOT a tabs widget: the
          editor below isn't a separate tabpanel). aria-pressed is the honest
          semantic. Both shown; a tenant save is server-gated to superadmins. */}
      <div className="action-bar" role="group" aria-label={t('title')}>
        <button type="button" aria-pressed={scope === 'user'} className={scope === 'user' ? 'primary btn-sm' : 'secondary btn-sm'} onClick={() => setScope('user')}>{t('scopeMine')}</button>
        <button type="button" aria-pressed={scope === 'tenant'} className={scope === 'tenant' ? 'primary btn-sm' : 'secondary btn-sm'} onClick={() => setScope('tenant')}>{t('scopeTenant')}</button>
      </div>
      <p className="muted u-fs-12">{scope === 'user' ? t('scopeMineHint') : t('scopeTenantHint')}</p>
      {/* Persistent aria-live region so the unsaved-changes notice is ANNOUNCED
          when it appears (a conditionally-mounted Notice never reaches AT). */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {dirty ? <Notice variant="info">{t('unsaved')}</Notice> : null}
      </div>

      {items.length === 0 ? (
        <StateCard icon={<SettingsIcon size={20} />} title={t('noItems')} />
      ) : (
        <div className="card-grid">
          {EDIT_TIERS.map((tier) => {
            const headers = headersForTier(tier);
            return (
              <section key={tier} className="surface-card u-flex u-flex-col u-gap-3" aria-label={tierLabel(tier)}>
                <h2 className="u-fs-14">{tierLabel(tier)}</h2>
                {headers.map((h) => {
                  const headerItems = items.filter((it) => effTier(it) === tier && effGroup(it) === h.id);
                  if (headerItems.length === 0 && !isCustomId(h.id)) return null;
                  return (
                    <div key={h.id} className="u-flex u-flex-col u-gap-2">
                      <HeaderRow
                        id={h.id}
                        tier={tier}
                        label={h.label}
                        deletable={isCustomId(h.id)}
                        onRename={(v) => renameHeader(h.id, tier, v)}
                        onRemove={() => void removeHeader(h.id)}
                        renameLabel={t('rename')}
                        removeLabel={t('remove')}
                      />
                      <ul className="u-flex u-flex-col u-gap-2 u-list-none">
                        {headerItems.map((it) => (
                          <li key={it.path}>
                            <ItemRow
                              item={it}
                              tier={tier}
                              groupId={h.id}
                              hidden={isHidden(it)}
                              headerOptions={headersForTier(tier)}
                              onMenu={(toTier) => patchItem(it.path, { tier: toTier === it.declaredTier ? undefined : toTier })}
                              onHeader={(gid) => patchItem(it.path, { group: gid === it.declaredGroup ? undefined : gid })}
                              onVisible={(v) => patchItem(it.path, { hidden: v ? undefined : true })}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <AddHeader onAdd={(label) => addHeader(tier, label)} placeholder={t('headerNamePlaceholder')} addLabel={t('addHeader')} />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HeaderRow({ id, label, deletable, onRename, onRemove, renameLabel, removeLabel }: {
  id: string; tier: FeatureTier; label: string; deletable: boolean;
  onRename: (v: string) => void; onRemove: () => void; renameLabel: string; removeLabel: string;
}): JSX.Element {
  const [value, setValue] = useState(label);
  useEffect(() => { setValue(label); }, [label]);
  return (
    <div className="u-flex u-items-center u-gap-2">
      <TextField
        label={renameLabel}
        className="u-flex-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value.trim() && value !== label) onRename(value.trim()); }}
      />
      {deletable ? (
        <IconButton label={`${removeLabel}: ${label}`} title={removeLabel} onClick={onRemove} icon={<TrashIcon size={14} />} />
      ) : null}
      <input type="hidden" value={id} readOnly />
    </div>
  );
}

function ItemRow({ item, tier, groupId, hidden, headerOptions, onMenu, onHeader, onVisible }: {
  item: EditableItem; tier: FeatureTier; groupId: string; hidden: boolean;
  headerOptions: { id: string; label: string }[];
  onMenu: (tier: FeatureTier) => void; onHeader: (groupId: string) => void; onVisible: (v: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation('navigation-settings');
  const { t: tn } = useTranslation('nav');
  const declaredGroupLabel = tn(GROUP_LABEL_KEYS[item.declaredGroup] ?? '', { defaultValue: item.declaredGroup });
  const declaredTierLabel = item.declaredTier === 'workspace' ? t('mainMenu') : t('adminMenu');
  return (
    <div className={`surface-card u-flex u-items-center u-gap-3 u-flex-wrap`}>
      <div className="u-flex-1 u-minw-0">
        <div className="u-fs-13">{item.label}</div>
        <div className="muted u-fs-11">{t('suggested', { tier: declaredTierLabel, group: declaredGroupLabel })}</div>
      </div>
      <SelectField label={t('menuLabel')} value={tier} onChange={(e) => onMenu(e.target.value as FeatureTier)}>
        <option value="workspace">{t('mainMenu')}</option>
        <option value="admin">{t('adminMenu')}</option>
      </SelectField>
      <SelectField label={t('headerLabel')} value={groupId} onChange={(e) => onHeader(e.target.value)}>
        {headerOptions.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
      </SelectField>
      {item.alwaysOn ? (
        <span className="chip" title={t('alwaysOnHint')}><LockIcon size={12} /> {t('alwaysOn')}</span>
      ) : (
        <CheckboxField label={t('visible')} checked={!hidden} onChange={(e) => onVisible(e.target.checked)} />
      )}
    </div>
  );
}

function AddHeader({ onAdd, placeholder, addLabel }: {
  onAdd: (label: string) => void; placeholder: string; addLabel: string;
}): JSX.Element {
  const [value, setValue] = useState('');
  const submit = () => { if (value.trim()) { onAdd(value.trim()); setValue(''); } };
  return (
    <div className="u-flex u-items-end u-gap-2">
      <TextField label={addLabel} className="u-flex-1" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <button type="button" className="secondary btn-sm" onClick={submit} disabled={!value.trim()}><PlusIcon size={13} /> {addLabel}</button>
    </div>
  );
}
