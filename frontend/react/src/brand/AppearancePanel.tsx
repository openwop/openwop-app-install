/**
 * Appearance (ADR 0170 + ADR 0171) — the SUPER-ADMIN surface to set the white-label
 * app identity at runtime, no rebuild. It edits the reserved app brand via
 * `/host/openwop-app/app-brand` (host authority, never org-scoped).
 *
 * ADR 0171: theming is GENERATIVE, not preset-picking. The operator sets a small
 * input set — an accent seed (+ optional neutral seed), contrast level, corner
 * radius, fonts — and the generator (theme/generate.ts) deterministically produces
 * the full light+dark token set, with the accent kept exact (fidelity) and the
 * on-colors solved for WCAG-AA. The preview runs the generator live; the advanced
 * tier exposes a per-token override via JSON import/export. On save the generated
 * tokens are applied to the live `:root` (+ cached for the next pre-paint), so the
 * chrome re-skins without a reload. Non-superadmins see a read-only notice.
 *
 * i18n: localized via the `appearance` namespace (4 locales; core catalog —
 * the `brand` ns belongs to the features/brand Brand & Guardrails package), XC-3/ADM-4.
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { confirm } from '../ui/confirm.js';
import { Field } from '../ui/Field.js';
import { Skeleton } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import { AlertIcon, CheckIcon, SaveIcon, SparklesIcon } from '../ui/icons/index.js';
import { StateCard } from '../ui/StateCard.js';
import { ApiError } from '../client/requestJson.js';
import { getAppBrand, postAppBrandAsset, putAppBrand } from './appBrandClient.js';
import {
  applyBrandIdentity,
  applyGeneratedTokens,
  cacheGeneratedTokens,
  cacheIdentity,
  clearGeneratedTokens,
  hasGenerativeTheme,
  hydrateBrandSingleton,
  splitGeneratorOwnedOverride,
  toThemeInputs,
  type PublicBrandIdentity,
} from './applyBrand.js';
import { generateTheme, STOCK_ACCENT, type GeneratedTheme } from './theme/generate.js';
import { analyzeThemeContrast, type ContrastReport } from './theme/analyze.js';
import { numStr, parseColorToRgb, rgbToHex } from './theme/oklch.js';
import { BRAND_PRESETS, FONT_PAIRINGS } from './defaults.js';

type Id = PublicBrandIdentity;
type ThemeIn = NonNullable<Id['theme']>;

/** Compose a generated map (+ advanced override) + the brand fonts into a scoped
 *  preview style — so a candidate theme recolors its container without touching the
 *  live `:root`. (Light vs dark is set by the container's theme class.) */
function previewStyle(map: Record<string, string>, override: Record<string, string> | undefined, typo: Id['typography']): CSSProperties {
  const vars: Record<string, string> = { ...map, ...override };
  if (typo?.serif) vars['--serif'] = typo.serif;
  if (typo?.sans) vars['--sans'] = typo.sans;
  return vars as CSSProperties; // CSS custom properties need the assertion
}

/** A color seed control: a native swatch + a free-text field (so oklch/hex/rgb all
 *  work, while the swatch stays friendly). Both edit the same seed string. */
function SeedField({ label, help, value, onChange }: { label: string; help?: string; value: string; onChange: (v: string) => void }): JSX.Element {
  const { t } = useTranslation('appearance');
  const hex = useMemo(() => rgbToHex(parseColorToRgb(value || STOCK_ACCENT) ?? [0, 0, 0]), [value]);
  return (
    <Field label={label} help={help}>
      {(p) => (
        <div className="u-flex u-gap-2 u-items-center">
          <input type="color" aria-label={t('swatchLabel', { label })} value={hex} onChange={(e) => onChange(e.target.value)} className="appearance-swatch" />
          <input {...p} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('seedPlaceholder')} />
        </div>
      )}
    </Field>
  );
}

/** ADR 0511 — per-slot brand-asset upload: reads the file, publishes it through
 *  the copy-on-select endpoint (raster-only, magic-byte-validated server-side),
 *  and hands back the copy's capability URL for the identity field. The
 *  file-input rides a label.btn-ghost (the CAD-import affordance pattern —
 *  :focus-within carries the ring). */
function AssetUpload({ slot, onUploaded }: { slot: string; onUploaded: (url: string) => void }): JSX.Element {
  const { t } = useTranslation('appearance');
  const [busy, setBusy] = useState(false);
  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      const { url } = await postAppBrandAsset({ slot, contentBase64: btoa(bin), contentType: file.type });
      onUploaded(url);
      toast.success(t('assetUploaded'));
    } catch (err) {
      // Server messages are actionable (type mismatch, SVG rejection, size cap).
      toast.error(err instanceof Error ? err.message : t('actionFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className={`btn-ghost btn-sm u-self-start${busy ? ' u-dim-disabled' : ''}`} aria-busy={busy || undefined}>
      <input
        type="file"
        className="sr-only"
        accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon"
        disabled={busy}
        onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      {busy ? t('assetUploading') : t('assetUpload')}
    </label>
  );
}

export function AppearancePanel(): JSX.Element {
  const { t } = useTranslation('appearance');
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 'App identity' is a PLACEHOLDER, not a value the tenant chose. On a failed
  // read it used to sit in the name field of a form whose Save is a full
  // `putAppBrand` replacement — one click renamed the white-labelled product to
  // this string and wiped every logo/colour/font override.
  const [name, setName] = useState('App identity');
  /** The brand read FAILED — the form below must not offer to overwrite what it
   *  could not read. Distinct from `denied` (a 403, which hides the panel). */
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped by the retry — the effect below is the only place the brand is read. */
  const [reload, setReload] = useState(0);
  const [id, setId] = useState<Id>({});
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  /** Generator-owned tokens found in an override (a legacy save or a pasted JSON).
   *  The server drops them (ADR 0510 §5) — name them visibly so the editor never
   *  pretends they will persist. */
  const [droppedTokens, setDroppedTokens] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const brand = await getAppBrand();
        if (!live) return;
        setName(brand.name);
        // A pre-ADR-0510 brand may hold overrides for tokens that are now
        // generator-owned. Strip them from the editor state (they no longer
        // survive a save) and say so, instead of previewing a theme the next
        // save silently changes.
        const identity = brand.identity ?? {};
        const { kept, dropped } = splitGeneratorOwnedOverride(identity.theme?.override);
        if (dropped.length && identity.theme) {
          identity.theme = { ...identity.theme };
          if (kept) identity.theme.override = kept; else delete identity.theme.override;
        }
        setDroppedTokens(dropped);
        setId(identity);
        setLoadFailed(false);
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 403) setDenied(true);
        else { setLoadFailed(true); setError(err instanceof Error ? err.message : t('actionFailed')); }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [t, reload]);

  /** Shallow-merge a patch into the identity (nested objects merged one level). */
  const patch = useCallback((p: Partial<Id>) => {
    setId((prev) => {
      const next: Id = { ...prev, ...p };
      if (p.wordmark) next.wordmark = { ...(prev.wordmark ?? { pre: '', emphasis: '', sub: '' }), ...p.wordmark };
      if (p.logo) next.logo = { ...prev.logo, ...p.logo };
      if (p.typography) next.typography = { ...prev.typography, ...p.typography };
      if (p.theme) next.theme = { ...prev.theme, ...p.theme };
      return next;
    });
  }, []);

  const patchTheme = useCallback((t: Partial<ThemeIn>) => patch({ theme: t }), [patch]);

  const applyPreset = useCallback((presetId: string) => {
    const preset = BRAND_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const pairing = FONT_PAIRINGS.find((f) => f.id === preset.fontPairing);
    patch({
      theme: { accentSeed: preset.accent, ...(preset.neutralSeed ? { neutralSeed: preset.neutralSeed } : {}) },
      ...(pairing ? { typography: { serif: pairing.serif, sans: pairing.sans, mono: pairing.mono, fontsHref: pairing.fontsHref } } : {}),
    });
  }, [patch]);

  const applyPairing = useCallback((pairingId: string) => {
    const f = FONT_PAIRINGS.find((p) => p.id === pairingId);
    if (f) patch({ typography: { serif: f.serif, sans: f.sans, mono: f.mono, fontsHref: f.fontsHref } });
  }, [patch]);

  // The generator runs live for the preview (this whole panel is lazy-chunked).
  const gen: GeneratedTheme = useMemo(() => generateTheme(toThemeInputs(id.theme)), [id.theme]);
  // Contrast analysis of the EFFECTIVE theme (generated + advanced override).
  const report: ContrastReport = useMemo(
    () => analyzeThemeContrast({ ...gen.light, ...id.theme?.override?.light }, { ...gen.dark, ...id.theme?.override?.dark }),
    [gen, id.theme?.override],
  );

  const persist = useCallback(async (next: Id, successMsg: string) => {
    setSaving(true);
    try {
      const brand = await putAppBrand({ name, identity: next });
      const saved = brand.identity ?? {};
      setId(saved);
      applyBrandIdentity(saved);     // typography / logo / title / meta + legacy colors
      hydrateBrandSingleton(saved);  // update React-rendered brand fields
      cacheIdentity(saved);          // next load's pre-paint (identity)
      if (hasGenerativeTheme(saved.theme)) {
        const t = generateTheme(toThemeInputs(saved.theme));
        const light = { ...t.light, ...saved.theme?.override?.light };
        const dark = { ...t.dark, ...saved.theme?.override?.dark };
        applyGeneratedTokens(light, dark); // re-skin the live :root immediately
        cacheGeneratedTokens(light, dark); // next load's pre-paint (tokens)
      } else {
        clearGeneratedTokens(); // e.g. Reset — un-skin back to stock
      }
      toast.success(successMsg);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) { setDenied(true); return; }
      toast.error(err instanceof Error ? err.message : t('actionFailed'));
    } finally {
      setSaving(false);
    }
  }, [name, t]);

  const applyJson = useCallback(() => {
    setJsonError(null);
    try {
      const parsed = JSON.parse(jsonDraft) as ThemeIn;
      if (!parsed || typeof parsed !== 'object') throw new Error(t('jsonExpectedObject'));
      // Reject generator-owned tokens VISIBLY (ADR 0510 §5) — the server drops
      // them, so applying them to the preview would show a theme that can't save.
      const { kept, dropped } = splitGeneratorOwnedOverride(parsed.override);
      const next: ThemeIn = { ...parsed };
      if (kept) next.override = kept; else delete next.override;
      setDroppedTokens(dropped);
      patch({ theme: next });
      toast.success(t('jsonApplied'));
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : t('jsonInvalid'));
    }
  }, [jsonDraft, patch, t]);

  if (loading) return <div className="u-p-4"><Skeleton /></div>;

  // Everything below this point edits brand identity and saves a FULL
  // `putAppBrand` replacement. None of it may render over a brand we failed to
  // read: the name field would show the 'App identity' placeholder and one Save
  // would rename the white-labelled product and wipe every token override.
  // Mirrors the `denied` early return directly below.
  if (loadFailed) {
    return (
      <div className="u-grid u-gap-3">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('ledeShort')} />
        <StateCard
          announce
          icon={<AlertIcon size={26} />}
          title={t('brandLoadFailedTitle')}
          body={t('brandLoadFailedBody')}
          action={<Button variant="secondary" onClick={() => setReload((n) => n + 1)}>{t('brandRetry')}</Button>}
        />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="u-grid u-gap-3">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('ledeShort')} />
        <Notice variant="warning">
          <Trans i18nKey="deniedNotice" ns="appearance" components={{ 1: <strong />, 3: <code /> }} />
        </Notice>
      </div>
    );
  }

  const wm = id.wordmark ?? { pre: '', emphasis: '', sub: '' };
  const theme = id.theme ?? {};

  return (
    <div className="u-grid u-gap-4" data-walkthrough="appearance.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('ledeFull')}
        actions={
          <div className="action-bar">
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => void (async () => {
                const ok = await confirm({
                  title: t('resetTitle'),
                  body: t('resetBody'),
                  danger: true,
                  confirmLabel: t('resetLabel'),
                });
                if (ok) await persist({}, t('resetSuccess'));
              })()}
            >
              {t('resetToDefault')}
            </Button>
            <Button variant="primary"
              disabled={saving}
              onClick={() => void (async () => {
                // ADR 0510 §5: AA is a persistence invariant — there is no path
                // that saves a failing theme. The button stays ENABLED so the
                // refusal is REACHABLE and announced (ADR 0482 ux-6 doctrine:
                // never a silent dead button); the warning Notice above names
                // the failing pairs.
                if (!report.pass) { toast.error(t('contrastBelowAA')); return; }
                await persist(id, t('saveSuccess'));
              })()}
            >
              <SaveIcon size={15} /> {saving ? t('saving') : t('save')}
            </Button>
          </div>
        }
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <section className="surface-card u-grid u-gap-3 u-p-4">
        <h2 className="u-fs-16 u-m-0"><SparklesIcon size={15} /> {t('quickStart')}</h2>
        <p className="u-m-0 u-fs-13 muted">{t('quickStartHint')}</p>
        <div className="action-bar">
          {BRAND_PRESETS.map((p) => (
            <Button key={p.id} variant="secondary" onClick={() => applyPreset(p.id)}>{p.name}</Button>
          ))}
        </div>
      </section>

      {gen.warnings.length ? (
        <Notice variant="warning">
          <strong>{t('contrastLabel')}</strong> {gen.warnings.join('; ')}. {t('contrastAdvice')}
        </Notice>
      ) : null}
      {!report.pass && !gen.warnings.length ? (
        <Notice variant="warning">
          <strong>{t('contrastCheckLabel')}</strong> {t('contrastBelowAA')}
        </Notice>
      ) : null}

      <div className="builder-two-col u-grid u-gap-4">
        <div className="u-grid u-gap-4" data-walkthrough="appearance.page">
          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">{t('themeHeading')}</h2>
            <SeedField label={t('brandColorLabel')} help={t('brandColorHelp')} value={theme.accentSeed ?? id.colors?.accent ?? ''} onChange={(v) => patchTheme({ accentSeed: v })} />
            <SeedField label={t('bgTintLabel')} help={t('bgTintHelp')} value={theme.neutralSeed ?? ''} onChange={(v) => patchTheme({ neutralSeed: v })} />
            <div className="u-grid-3">
              <Field label={t('contrastFieldLabel')}>
                {(p) => (
                  <select {...p} value={theme.contrastLevel ?? 'standard'} onChange={(e) => patchTheme({ contrastLevel: e.target.value as 'standard' | 'medium' | 'high' })}>
                    <option value="standard">{t('contrastStandard')}</option>
                    <option value="medium">{t('contrastMedium')}</option>
                    <option value="high">{t('contrastHigh')}</option>
                  </select>
                )}
              </Field>
              <Field label={t('cornersLabel')}>
                {(p) => (
                  <select {...p} value={theme.radius ?? ''} onChange={(e) => setId((prev) => { const th = { ...prev.theme }; const v = e.target.value; if (v) th.radius = v as 'sm' | 'md' | 'lg'; else delete th.radius; return { ...prev, theme: th }; })}>
                    <option value="">{t('cornersDefault')}</option>
                    <option value="sm">{t('cornersSharp')}</option>
                    <option value="md">{t('cornersMedium')}</option>
                    <option value="lg">{t('cornersRound')}</option>
                  </select>
                )}
              </Field>
              <Field label={t('defaultThemeLabel')}>
                {(p) => (
                  <select {...p} value={theme.defaultMode ?? 'system'} onChange={(e) => patchTheme({ defaultMode: e.target.value as 'system' | 'light' | 'dark' })}>
                    <option value="system">{t('themeSystem')}</option>
                    <option value="light">{t('themeLight')}</option>
                    <option value="dark">{t('themeDark')}</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label={t('fontPairingLabel')}>
              {(p) => (
                <select {...p} value={FONT_PAIRINGS.find((f) => f.serif === id.typography?.serif)?.id ?? ''} onChange={(e) => applyPairing(e.target.value)}>
                  <option value="">{t('fontCustom')}</option>
                  {FONT_PAIRINGS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
            </Field>
          </section>

          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">{t('identityHeading')}</h2>
            <Field label={t('productNameLabel')}>{(p) => <input {...p} value={id.productName ?? ''} onChange={(e) => patch({ productName: e.target.value })} />}</Field>
            <div className="u-grid-3">
              <Field label={t('wordmarkPreLabel')}>{(p) => <input {...p} value={wm.pre} onChange={(e) => patch({ wordmark: { ...wm, pre: e.target.value } })} />}</Field>
              <Field label={t('wordmarkEmphasisLabel')}>{(p) => <input {...p} value={wm.emphasis} onChange={(e) => patch({ wordmark: { ...wm, emphasis: e.target.value } })} />}</Field>
              <Field label={t('wordmarkSubLabel')}>{(p) => <input {...p} value={wm.sub} onChange={(e) => patch({ wordmark: { ...wm, sub: e.target.value } })} />}</Field>
            </div>
            <Field label={t('documentTitleLabel')}>{(p) => <input {...p} value={id.documentTitle ?? ''} onChange={(e) => patch({ documentTitle: e.target.value })} />}</Field>
          </section>

          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">{t('logoHeading')}</h2>
            <Field label={t('logoUrlLabel')} help={t('logoUrlHelp')}>
              {(p) => (
                <div className="u-grid u-gap-1">
                  <input {...p} value={id.logo?.markSrc ?? ''} onChange={(e) => patch({ logo: { markSrc: e.target.value } })} placeholder="/brand/logo.svg" />
                  <AssetUpload slot="mark" onUploaded={(url) => patch({ logo: { markSrc: url } })} />
                </div>
              )}
            </Field>
            <Field label={t('logoDarkUrlLabel')} help={t('logoDarkUrlHelp')}>
              {(p) => (
                <div className="u-grid u-gap-1">
                  <input {...p} value={id.logo?.markSrcDark ?? ''} onChange={(e) => patch({ logo: { markSrcDark: e.target.value } })} placeholder="/brand/logo-dark.svg" />
                  <AssetUpload slot="markDark" onUploaded={(url) => patch({ logo: { markSrcDark: url } })} />
                </div>
              )}
            </Field>
            <Field label={t('faviconLabel')}>
              {(p) => (
                <div className="u-grid u-gap-1">
                  <input {...p} value={id.logo?.faviconSrc ?? ''} onChange={(e) => patch({ logo: { faviconSrc: e.target.value } })} placeholder="data:image/svg+xml,…" />
                  <AssetUpload slot="favicon" onUploaded={(url) => patch({ logo: { faviconSrc: url } })} />
                </div>
              )}
            </Field>
          </section>

          <details className="surface-card u-p-4">
            <summary className="u-fs-16 u-fw-600 appearance-summary">{t('advancedSummary')}</summary>
            <div className="u-grid u-gap-2 u-mt-3">
              <p className="u-m-0 u-fs-13 muted"><Trans i18nKey="advancedHint" ns="appearance" components={{ 1: <code />, 3: <code /> }} /></p>
              <div className="action-bar">
                <Button variant="secondary" onClick={() => setJsonDraft(JSON.stringify(id.theme ?? {}, null, 2))}>{t('exportCurrent')}</Button>
                <Button variant="secondary" disabled={!jsonDraft.trim()} onClick={applyJson}>{t('applyJsonBtn')}</Button>
              </div>
              <Field label={t('themeJsonLabel')}>
                {(p) => <textarea {...p} rows={8} value={jsonDraft} onChange={(e) => setJsonDraft(e.target.value)} spellCheck={false} placeholder='{ "accentSeed": "…", "override": { "light": { "--cat-ai": "…" } } }' />}
              </Field>
              {jsonError ? <Notice variant="error">{jsonError}</Notice> : null}
              {droppedTokens.length ? (
                <Notice variant="warning">
                  {t('generatorOwnedDropped', { tokens: droppedTokens.join(', ') })}
                </Notice>
              ) : null}
            </div>
          </details>
        </div>

        <div className="u-grid u-gap-4 appearance-preview-col">
          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">{t('livePreviewHeading')}</h2>
            <span className="u-label-sm">{t('lightLabel')}</span>
            <div className="theme-light brand-preview surface-card u-grid u-gap-2 u-p-3" style={previewStyle(gen.light, theme.override?.light, id.typography)}>
              <PreviewContent wm={wm} name={id.productName} logo={id.logo?.markSrc} />
            </div>
            <span className="u-label-sm">{t('darkLabel')}</span>
            <div className="theme-dark brand-preview surface-card u-grid u-gap-2 u-p-3" style={previewStyle(gen.dark, theme.override?.dark, id.typography)}>
              <PreviewContent wm={wm} name={id.productName} logo={id.logo?.markSrc} />
            </div>
          </section>

          <section className="surface-card u-grid u-gap-2 u-p-4">
            <h2 className="u-fs-16 u-m-0">{t('contrastHeading')} <span className="muted u-fs-12">{t('contrastHeadingSub')}</span></h2>
            {report.pairs.length === 0 ? (
              <p className="u-m-0 u-fs-13 muted">{t('stockThemeNote')}</p>
            ) : (
              report.pairs.map((p) => (
                <div key={`${p.mode}-${p.label}`} className="u-flex u-justify-between u-items-center u-fs-13">
                  <span>{p.label} <span className="muted">· {p.mode}</span></span>
                  <span className="u-flex u-gap-2 u-items-center">
                    <span title={p.issue ? `${p.issue}: ${p.foreground} / ${p.background}` : undefined}>{numStr(p.ratio, 1)}:1</span>
                    <span role="img" aria-label={p.pass ? t('meetsAA') : t('belowAA')}>
                      {p.pass ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                    </span>
                    <span className="muted u-fs-12">Lc {numStr(Math.abs(p.apca), 0)}</span>
                  </span>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PreviewContent({ wm, name, logo }: { wm: { pre: string; emphasis: string; sub: string }; name: string | undefined; logo: string | undefined }): JSX.Element {
  const { t } = useTranslation('appearance');
  // Illustrative only — `aria-hidden` + non-interactive <span>s so the sample isn't
  // a dead tab-stop or announced as real controls to assistive tech. Exercises the
  // surfaces an operator can't otherwise see: the secondary surface, a rule, muted
  // text, the accent fill + the derived accent text.
  return (
    <div aria-hidden="true" className="u-grid u-gap-2">
      {logo ? (
        <img src={logo} alt="" className="appearance-preview-logo" />
      ) : (
        <span className="brand-mark u-m-0" style={{ fontFamily: 'var(--serif)' }}>
          {wm.pre || name || 'OpenWOP'}{wm.emphasis ? <em>{wm.emphasis}</em> : null}{' '}
          {wm.sub ? <span className="app-header-sub">{wm.sub}</span> : null}
        </span>
      )}
      <div className="action-bar">
        <Button variant="primary" disabled tabIndex={-1}>{t('previewPrimary')}</Button>
        <Button variant="secondary" disabled tabIndex={-1}>{t('previewSecondary')}</Button>
        <span className="chip">{t('previewStatus')}</span>
      </div>
      <div className="u-grid u-gap-1 u-p-2 appearance-preview-surface">
        <span className="u-fs-12 appearance-preview-muted">{t('previewSurfaceEyebrow')}</span>
        <span className="u-fs-13"><Trans i18nKey="previewCardLine" ns="appearance" components={{ 1: <code />, 3: <code /> }} /></span>
      </div>
      <p className="u-m-0 u-fs-13"><Trans i18nKey="previewBody" ns="appearance" components={{ 1: <span style={{ color: 'var(--clay-text)' }} /> }} /></p>
    </div>
  );
}
