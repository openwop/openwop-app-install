/**
 * Appearance (ADR 0170 + ADR 0171) — the SUPER-ADMIN surface to set the white-label
 * app identity at runtime, no rebuild. It edits the reserved app brand via
 * `/v1/host/openwop-app/app-brand` (host authority, never org-scoped).
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
 * i18n: this admin panel currently ships English copy (a tracked follow-up to add
 * the `appearance` catalog across locales — non-fatal per the check-i18n gate).
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { confirm } from '../ui/confirm.js';
import { Field } from '../ui/Field.js';
import { Skeleton } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import { AlertIcon, CheckIcon, SaveIcon, SparklesIcon } from '../ui/icons/index.js';
import { ApiError } from '../client/requestJson.js';
import { getAppBrand, putAppBrand } from './appBrandClient.js';
import {
  applyBrandIdentity,
  applyGeneratedTokens,
  cacheGeneratedTokens,
  cacheIdentity,
  clearGeneratedTokens,
  hasGenerativeTheme,
  hydrateBrandSingleton,
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
  const hex = useMemo(() => rgbToHex(parseColorToRgb(value || STOCK_ACCENT) ?? [0, 0, 0]), [value]);
  return (
    <Field label={label} help={help}>
      {(p) => (
        <div className="u-flex u-gap-2 u-items-center">
          <input type="color" aria-label={`${label} swatch`} value={hex} onChange={(e) => onChange(e.target.value)} style={{ width: 38, height: 32, padding: 0, background: 'none' }} />
          <input {...p} value={value} onChange={(e) => onChange(e.target.value)} placeholder="any CSS color — hex, rgb or oklch" />
        </div>
      )}
    </Field>
  );
}

export function AppearancePanel(): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('App identity');
  const [id, setId] = useState<Id>({});
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const brand = await getAppBrand();
        if (!live) return;
        setName(brand.name);
        setId(brand.identity ?? {});
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 403) setDenied(true);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, []);

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
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [name]);

  const applyJson = useCallback(() => {
    setJsonError(null);
    try {
      const parsed = JSON.parse(jsonDraft) as ThemeIn;
      if (!parsed || typeof parsed !== 'object') throw new Error('Expected a theme object');
      patch({ theme: parsed });
      toast.success('Theme JSON applied — review the preview, then Save.');
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }, [jsonDraft, patch]);

  if (loading) return <div className="u-p-4"><Skeleton /></div>;

  if (denied) {
    return (
      <div className="u-grid u-gap-3">
        <PageHeader eyebrow="Brand" title="Appearance" lede="Set the app's white-label identity." />
        <Notice variant="warning">
          Appearance is a <strong>super-admin</strong> surface. Add your tenant id to{' '}
          <code>OPENWOP_SUPERADMIN_TENANTS</code> to edit the app brand.
        </Notice>
      </div>
    );
  }

  const wm = id.wordmark ?? { pre: '', emphasis: '', sub: '' };
  const theme = id.theme ?? {};

  return (
    <div className="u-grid u-gap-4">
      <PageHeader
        eyebrow="Brand"
        title="Appearance"
        lede="Set this installation's colors, type, logo, and name. The accent generates a full, accessible light + dark theme — changes apply live, no rebuild."
        actions={
          <div className="action-bar">
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => void (async () => {
                const ok = await confirm({
                  title: 'Reset appearance to default?',
                  body: 'This clears the logo, colors, fonts, and name — for everyone using this install.',
                  danger: true,
                  confirmLabel: 'Reset',
                });
                if (ok) await persist({}, 'Reset to the default identity.');
              })()}
            >
              Reset to default
            </button>
            <button type="button" className="btn primary" disabled={saving} onClick={() => void persist(id, 'Appearance saved.')}>
              <SaveIcon size={15} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <section className="surface-card u-grid u-gap-3 u-p-4">
        <h2 className="u-fs-16 u-m-0"><SparklesIcon size={15} /> Quick start</h2>
        <p className="u-m-0 u-fs-13 u-text-muted">A starting point, not a fixed theme — change anything after.</p>
        <div className="action-bar">
          {BRAND_PRESETS.map((p) => (
            <button key={p.id} type="button" className="btn" onClick={() => applyPreset(p.id)}>{p.name}</button>
          ))}
        </div>
      </section>

      {gen.warnings.length ? (
        <Notice variant="warning">
          <strong>Contrast:</strong> {gen.warnings.join('; ')}. Lower the contrast target or pick a different accent.
        </Notice>
      ) : null}
      {!report.pass && !gen.warnings.length ? (
        <Notice variant="warning">
          <strong>Contrast check:</strong> a token pair falls below WCAG AA — see the Contrast panel. Generated colors are auto-adjusted; advanced overrides are not.
        </Notice>
      ) : null}

      <div className="builder-two-col u-grid u-gap-4">
        <div className="u-grid u-gap-4">
          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">Theme</h2>
            <SeedField label="Brand color" help="Used for buttons, links, and highlights — kept exact, with a readable text shade derived for you." value={theme.accentSeed ?? id.colors?.accent ?? ''} onChange={(v) => patchTheme({ accentSeed: v })} />
            <SeedField label="Background tint" help="Optional — gives page surfaces a subtle hue. Leave empty for the default warm grey." value={theme.neutralSeed ?? ''} onChange={(v) => patchTheme({ neutralSeed: v })} />
            <div className="u-grid u-gap-2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <Field label="Contrast">
                {(p) => (
                  <select {...p} value={theme.contrastLevel ?? 'standard'} onChange={(e) => patchTheme({ contrastLevel: e.target.value as 'standard' | 'medium' | 'high' })}>
                    <option value="standard">Standard (AA)</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                )}
              </Field>
              <Field label="Corners">
                {(p) => (
                  <select {...p} value={theme.radius ?? ''} onChange={(e) => setId((prev) => { const t = { ...prev.theme }; const v = e.target.value; if (v) t.radius = v as 'sm' | 'md' | 'lg'; else delete t.radius; return { ...prev, theme: t }; })}>
                    <option value="">Default</option>
                    <option value="sm">Sharp</option>
                    <option value="md">Medium</option>
                    <option value="lg">Round</option>
                  </select>
                )}
              </Field>
              <Field label="Default theme">
                {(p) => (
                  <select {...p} value={theme.defaultMode ?? 'system'} onChange={(e) => patchTheme({ defaultMode: e.target.value as 'system' | 'light' | 'dark' })}>
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label="Font pairing">
              {(p) => (
                <select {...p} value={FONT_PAIRINGS.find((f) => f.serif === id.typography?.serif)?.id ?? ''} onChange={(e) => applyPairing(e.target.value)}>
                  <option value="">Custom / unchanged</option>
                  {FONT_PAIRINGS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
            </Field>
          </section>

          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">Identity</h2>
            <Field label="Product name">{(p) => <input {...p} value={id.productName ?? ''} onChange={(e) => patch({ productName: e.target.value })} />}</Field>
            <div className="u-grid u-gap-2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <Field label="Wordmark — pre">{(p) => <input {...p} value={wm.pre} onChange={(e) => patch({ wordmark: { ...wm, pre: e.target.value } })} />}</Field>
              <Field label="emphasis">{(p) => <input {...p} value={wm.emphasis} onChange={(e) => patch({ wordmark: { ...wm, emphasis: e.target.value } })} />}</Field>
              <Field label="sub">{(p) => <input {...p} value={wm.sub} onChange={(e) => patch({ wordmark: { ...wm, sub: e.target.value } })} />}</Field>
            </div>
            <Field label="Document title">{(p) => <input {...p} value={id.documentTitle ?? ''} onChange={(e) => patch({ documentTitle: e.target.value })} />}</Field>
          </section>

          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">Logo</h2>
            <Field label="Logo / mark URL" help="An https URL, a /relative path, or a data:image URI. Upload arrives with Media (ADR 0007).">
              {(p) => <input {...p} value={id.logo?.markSrc ?? ''} onChange={(e) => patch({ logo: { markSrc: e.target.value } })} placeholder="/brand/logo.svg" />}
            </Field>
            <Field label="Favicon URL">
              {(p) => <input {...p} value={id.logo?.faviconSrc ?? ''} onChange={(e) => patch({ logo: { faviconSrc: e.target.value } })} placeholder="data:image/svg+xml,…" />}
            </Field>
          </section>

          <details className="surface-card u-p-4">
            <summary className="u-fs-16 u-fw-600" style={{ cursor: 'pointer' }}>Advanced — token override (JSON)</summary>
            <div className="u-grid u-gap-2 u-mt-3">
              <p className="u-m-0 u-fs-13 u-text-muted">Export the current theme inputs, or paste a theme JSON to apply. Per-token overrides go under <code>override.light</code> / <code>override.dark</code> (allowlisted tokens only — others are dropped on save).</p>
              <div className="action-bar">
                <button type="button" className="btn" onClick={() => setJsonDraft(JSON.stringify(id.theme ?? {}, null, 2))}>Export current</button>
                <button type="button" className="btn" disabled={!jsonDraft.trim()} onClick={applyJson}>Apply JSON</button>
              </div>
              <Field label="Theme JSON">
                {(p) => <textarea {...p} rows={8} value={jsonDraft} onChange={(e) => setJsonDraft(e.target.value)} spellCheck={false} placeholder='{ "accentSeed": "…", "override": { "light": { "--clay": "…" } } }' />}
              </Field>
              {jsonError ? <Notice variant="error">{jsonError}</Notice> : null}
            </div>
          </details>
        </div>

        <div className="u-grid u-gap-4" style={{ position: 'sticky', top: '1rem', alignSelf: 'start' }}>
          <section className="surface-card u-grid u-gap-3 u-p-4">
            <h2 className="u-fs-16 u-m-0">Live preview</h2>
            <span className="u-label-sm">Light</span>
            <div className="theme-light brand-preview surface-card u-grid u-gap-2 u-p-3" style={previewStyle(gen.light, theme.override?.light, id.typography)}>
              <PreviewContent wm={wm} name={id.productName} logo={id.logo?.markSrc} />
            </div>
            <span className="u-label-sm">Dark</span>
            <div className="theme-dark brand-preview surface-card u-grid u-gap-2 u-p-3" style={previewStyle(gen.dark, theme.override?.dark, id.typography)}>
              <PreviewContent wm={wm} name={id.productName} logo={id.logo?.markSrc} />
            </div>
          </section>

          <section className="surface-card u-grid u-gap-2 u-p-4">
            <h2 className="u-fs-16 u-m-0">Contrast <span className="u-text-muted u-fs-12">· WCAG AA · APCA advisory</span></h2>
            {report.pairs.length === 0 ? (
              <p className="u-m-0 u-fs-13 u-text-muted">Stock theme — surfaces meet AA (axe-verified).</p>
            ) : (
              report.pairs.map((p) => (
                <div key={`${p.mode}-${p.label}`} className="u-flex u-justify-between u-items-center u-fs-13">
                  <span>{p.label} <span className="u-text-muted">· {p.mode}</span></span>
                  <span className="u-flex u-gap-2 u-items-center">
                    <span>{numStr(p.ratio, 1)}:1</span>
                    <span className={`u-flex ${p.pass ? 'u-text-success' : 'u-text-danger'}`} aria-label={p.pass ? 'meets AA' : 'below AA'}>
                      {p.pass ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                    </span>
                    <span className="u-text-muted u-fs-12">Lc {numStr(Math.abs(p.apca), 0)}</span>
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
  // Illustrative only — `aria-hidden` + non-interactive <span>s so the sample isn't
  // a dead tab-stop or announced as real controls to assistive tech. Exercises the
  // surfaces an operator can't otherwise see: the secondary surface, a rule, muted
  // text, the accent fill + the derived accent text.
  return (
    <div aria-hidden="true" className="u-grid u-gap-2">
      {logo ? (
        <img src={logo} alt="" style={{ maxHeight: 30, maxWidth: 180, objectFit: 'contain', alignSelf: 'start' }} />
      ) : (
        <span className="brand-mark u-m-0" style={{ fontFamily: 'var(--serif)' }}>
          {wm.pre || name || 'OpenWOP'}{wm.emphasis ? <em>{wm.emphasis}</em> : null}{' '}
          {wm.sub ? <span className="app-header-sub">{wm.sub}</span> : null}
        </span>
      )}
      <div className="action-bar">
        <span className="btn primary">Primary action</span>
        <span className="btn">Secondary</span>
        <span className="chip">Status</span>
      </div>
      <div className="u-grid u-gap-1 u-p-2" style={{ background: 'var(--paper-2)', border: '1px solid var(--rule)', borderRadius: 'var(--radius)' }}>
        <span className="u-fs-12" style={{ color: 'var(--ink-3)' }}>Secondary surface</span>
        <span className="u-fs-13">A card on <code>--paper-2</code> with a <code>--rule</code> border.</span>
      </div>
      <p className="u-m-0 u-fs-13">Body text in the brand sans, with an <span style={{ color: 'var(--clay-text)' }}>accent link</span>.</p>
    </div>
  );
}
