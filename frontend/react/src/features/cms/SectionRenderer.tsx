/**
 * Shared CMS section renderer (ADR 0027). ONE renderer for two modes:
 *   - `mode="editor"` — a rough live preview inside the CMS / Front-page editor.
 *   - `mode="public"` — the designed marketing front page (the "engineering
 *     broadsheet": serif display, mono numerals, the node-glyph motif, the
 *     cards / steps / stats layouts). Styled in styles/global.css (`.fp-*`).
 *
 * Content-safety posture (ADR 0009): NO `dangerouslySetInnerHTML`. Prose runs
 * through a tiny SAFE markdown subset — paragraphs + `**bold**` / `*italic*` /
 * `` `code` `` / `[label](url)` with an http(s)/mailto / internal-path guard.
 */
import type { ReactNode } from 'react';
import { Fragment, Suspense, lazy, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import i18n from '../../i18n/index.js';
import type { Section } from './cmsClient.js';
import { assetUrl } from './cmsClient.js';
import { headingSlug } from './headingSlug.js';
import { config, fetchOpts } from '../../client/config.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { useFormat } from '../../i18n/useFormat.js';
// ADR 0331 §D2 — the ONE public fill renderer, lazy so public pages without a
// form section never load it (and cms/→forms/ stays a soft edge).
const LazyPublicFormRenderer = lazy(() => import('../forms/render/PublicFormRenderer.js').then((m) => ({ default: m.PublicFormRenderer })));
import type { IconCmp } from '../../chrome/featureTypes.js';
import {
  MessageSquareIcon, MessageCircleIcon, BotIcon, WorkflowIcon, FolderIcon,
  InboxIcon, ColumnsIcon, ClockIcon, MonitorIcon, PlayIcon, BoxesIcon,
  PackageIcon, BriefcaseIcon, ShieldIcon, DatabaseIcon, StarIcon, ActivityIcon,
  BookOpenIcon, FileTextIcon, PencilIcon, MicIcon, SparklesIcon, ImageIcon,
  LayoutGridIcon, GlobeIcon, ClipboardIcon, ScaleIcon, FlagIcon, LifeBuoyIcon,
  ListIcon, MegaphoneIcon, LockIcon, PlugIcon, KeyIcon, BuildingIcon, UserIcon,
  SettingsIcon, TerminalIcon, LinkIcon,
  ArrowRightIcon,
} from '../../ui/icons/index.js';

/** Per-feature card icons (ADR 0027). A card's `icon` slug (authored in
 *  featurePages.json / editable in the CMS) maps to one glyph here; an absent or
 *  unknown slug falls back to the node motif (`NodeGlyph`). Slugs are semantic,
 *  so several may resolve to the same Lucide glyph across distant sections. */
const ICON_BY_SLUG: Record<string, IconCmp> = {
  chat: MessageSquareIcon, channels: MessageCircleIcon, comments: MessageCircleIcon,
  bot: BotIcon, workflow: WorkflowIcon, folder: FolderIcon, inbox: InboxIcon,
  board: ColumnsIcon, clock: ClockIcon, monitor: MonitorIcon, play: PlayIcon,
  boxes: BoxesIcon, package: PackageIcon, roster: BriefcaseIcon, briefcase: BriefcaseIcon,
  shield: ShieldIcon, database: DatabaseIcon, star: StarIcon, activity: ActivityIcon,
  book: BookOpenIcon, file: FileTextIcon, pencil: PencilIcon, mic: MicIcon,
  sparkles: SparklesIcon, image: ImageIcon, grid: LayoutGridIcon, globe: GlobeIcon,
  clipboard: ClipboardIcon, scale: ScaleIcon, flag: FlagIcon, lifebuoy: LifeBuoyIcon,
  list: ListIcon, megaphone: MegaphoneIcon, lock: LockIcon, plug: PlugIcon,
  key: KeyIcon, building: BuildingIcon, user: UserIcon, settings: SettingsIcon,
  terminal: TerminalIcon, link: LinkIcon,
};

/** A node-supplied string field, or '' when absent/non-string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Pricing `features` are the operator's ENTITLEMENT feature ids (`app-builder`,
 *  `cdp`) — internal slugs, not marketing copy. Humanize them for the public
 *  page: Title-case words, UPPER-case known acronyms. Best-effort, deterministic. */
const FEATURE_ACRONYMS = new Set(['cdp', 'cad', 'crm', 'cms', 'api', 'ai', 'seo', 'sso', 'sms', 'kb', 'ui', 'ux', 'a2a', 'mcp', 'rag', 'hitl', 'byok', 'kpi', 'faq', 'pdf', 'csv', 'url', 'rss', 'dpa', 'aup', 'sla']);
function humanizeFeatureId(id: string): string {
  // Limit keys are camelCase config keys (`workflowRuns`) — split those word
  // boundaries too, not just kebab/snake (R2-G5).
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean)
    .map((w) => (FEATURE_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
/** How many feature bullets a tier card shows before an "and N more" line. */
const FEATURE_CARD_CAP = 6;

export type SectionRenderMode = 'editor' | 'public';

/** An http(s)/mailto URL is safe as an external link; anything else is not. */
const isSafeHref = (url: string): boolean => /^(https?:|mailto:)/i.test(url.trim());
/** An internal app path (`/agents`) — single leading slash, NOT `//` or `/\`
 *  (both normalize to a protocol-relative EXTERNAL URL → open-redirect shape). */
const isInternal = (url: string): boolean => /^\/(?![/\\])/.test(url.trim());

/** Inline markdown → React nodes: `**bold**`, `*italic*`, `` `code` ``,
 *  `[label](url)`. No raw HTML; an unsafe link degrades to plain text. */
function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={key} className="fp-code">{m[3]}</code>);
    else if (m[4] !== undefined && m[5] !== undefined) {
      const label = m[4]; const url = m[5];
      out.push(isSafeHref(url)
        ? <a key={key} href={url} rel="noopener noreferrer">{label}</a>
        : isInternal(url) ? <Link key={key} to={url}>{label}</Link> : label);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render `text` as paragraphs (blank-line separated), inline-formatted. */
function RichText({ text, className = 'cms-richtext' }: { text: string; className?: string }): JSX.Element {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return <p className={className} />;
  return <>{paras.map((p, i) => <p key={i} className={className}>{inlineMarkdown(p, `p${i}`)}</p>)}</>;
}

// ── Public (front-page) building blocks ─────────────────────────────────────

/** Mono eyebrow + serif heading + an optional one-line orienting lede — the
 *  recurring section header. The lede gives a first-time reader one sentence of
 *  context under the heading (ADR 0027 Features page). */
function SectionHead({ eyebrow, heading, lede }: { eyebrow?: string | undefined; heading?: string | undefined; lede?: string | undefined }): JSX.Element | null {
  if (!eyebrow && !heading && !lede) return null;
  return (
    <header className="fp-head">
      {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
      {/* R2-D10 (UX_UPGRADE-docs) — a STABLE anchor id from the heading text,
          so fragment links resolve on cold load (they used to exist only after
          the docs TOC mutated the DOM) and the prerendered HTML carries the
          same ids for bots. Two sections sharing one heading collide: in the
          prerender first-wins (documented there); in the docs SPA `deriveToc`
          rewrites the LATER duplicate (R2R-1), keeping the first id stable. */}
      {heading ? <h2 id={headingSlug(heading)} className="fp-head__title">{heading}</h2> : null}
      {lede ? <p className="fp-head__lede">{inlineMarkdown(lede, 'lede')}</p> : null}
    </header>
  );
}

/** The openwop node motif — square / circle / diamond, cycled per index.
 *  The fallback when a card has no (or an unknown) `icon` slug. */
function NodeGlyph({ i }: { i: number }): JSX.Element {
  const shape = i % 3;
  return (
    <span className="fp-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20">
        {shape === 0 ? <rect x="5" y="5" width="14" height="14" rx="2.5" />
          : shape === 1 ? <circle cx="12" cy="12" r="8" />
            : <path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" />}
      </svg>
    </span>
  );
}

/** A card's glyph: the per-feature icon for a known `icon` slug, else the node
 *  motif. Same `.fp-glyph` chrome either way so the grid stays visually even. */
function CardGlyph({ icon, i }: { icon?: string | undefined; i: number }): JSX.Element {
  const Icon = icon ? ICON_BY_SLUG[icon] : undefined;
  if (!Icon) return <NodeGlyph i={i} />;
  return (
    <span className="fp-glyph" aria-hidden="true">
      <Icon size={20} />
    </span>
  );
}

/**
 * A deliberately illustrative, not-live, product vignette for the public hero.
 * The old outline-only diagram told the visitor that this was "technical," but
 * gave no sense of what the product helps them do. This keeps the node motif
 * while showing the simple arc OpenWOP is built for: shape work, run it, retain
 * a reviewable record. It is aria-hidden because the authored hero copy carries
 * the actual product claim.
 */
function HeroSchematic(): JSX.Element {
  return (
    <div className="fp-hero__product" aria-hidden="true">
      <div className="fp-product">
        <div className="fp-product__bar">
          <span className="fp-product__brand"><span className="fp-product__brand-mark" /> {i18n.t('site:heroVignetteName')}</span>
          <span className="fp-product__state">{i18n.t('site:heroVignetteReady')}</span>
        </div>
        <div className="fp-product__canvas">
          <div className="fp-product__node fp-product__node--brief">
            <span className="fp-product__node-kicker">{i18n.t('site:heroVignetteContext')}</span>
            <strong>{i18n.t('site:heroVignetteBrief')}</strong>
            <span>{i18n.t('site:heroVignetteCapture')}</span>
          </div>
          <span className="fp-product__wire fp-product__wire--one" />
          <div className="fp-product__node fp-product__node--route">
            <span className="fp-product__node-kicker">{i18n.t('site:heroVignetteWorkflow')}</span>
            <strong>{i18n.t('site:heroVignetteRoute')}</strong>
            <span>{i18n.t('site:heroVignetteTogether')}</span>
          </div>
          <span className="fp-product__wire fp-product__wire--two" />
          <div className="fp-product__node fp-product__node--review">
            <span className="fp-product__node-kicker">{i18n.t('site:heroVignetteRecord')}</span>
            <strong>{i18n.t('site:heroVignetteReview')}</strong>
            <span>{i18n.t('site:heroVignetteReplay')}</span>
          </div>
        </div>
        <div className="fp-product__footer">
          <span>{i18n.t('site:heroVignetteOpen')}</span>
          <span className="fp-product__footer-dot" />
          <span>{i18n.t('site:heroVignetteInfrastructure')}</span>
        </div>
      </div>
    </div>
  );
}

/** A calm momentum path: one human-sized next step, then visible progress. */
function HeroJourney(): JSX.Element {
  return (
    <svg className="fp-hero__schematic fp-hero__journey" viewBox="0 0 420 260" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <path className="fp-journey__wash" d="M34 228 C92 178 104 205 156 151 S245 82 382 40" />
      <path className="fp-journey__path" d="M34 228 C92 178 104 205 156 151 S245 82 382 40" />
      <circle className="fp-journey__step" cx="35" cy="227" r="9" />
      <circle className="fp-journey__step" cx="156" cy="151" r="9" />
      <circle className="fp-journey__step" cx="272" cy="78" r="9" />
      <circle className="fp-journey__goal" cx="382" cy="40" r="22" />
      <path className="fp-journey__check" d="M371 40 l8 8 15-18" />
    </svg>
  );
}

/** One line of the run ledger: a wire event name (never translated — it is the
 *  protocol's vocabulary) + the `site:` key of its plain-language gloss. */
const RUN_LEDGER: readonly { at: string; event: string; gloss: string; waits?: boolean }[] = [
  { at: '00.00', event: 'run.started', gloss: 'site:heroRunStarted' },
  { at: '00.41', event: 'agent.decided', gloss: 'site:heroRunDecided' },
  { at: '01.12', event: 'node.completed', gloss: 'site:heroRunToolReturned' },
  { at: '01.13', event: 'budget.consumed', gloss: 'site:heroRunBudget' },
  { at: '01.20', event: 'approval.requested', gloss: 'site:heroRunApprovalRequested', waits: true },
  { at: '03.47', event: 'approval.granted', gloss: 'site:heroRunApprovalGranted' },
  { at: '03.52', event: 'run.completed', gloss: 'site:heroRunCompleted' },
];

/**
 * The run, typeset as its event log — the front page's one signature visual.
 * The story is that the RUN (the loop where AI decides, calls tools, and stops
 * to ask a person) is what OpenWOP opens up, so the hero shows a run rather than
 * a diagram of one. Event names are real run-event types from the protocol;
 * the row where the run waits on a person carries the §6 `openwop-attention`
 * cue — the one human-action state on the page. Illustrative, not live, so it
 * is aria-hidden: the authored hero copy carries the claim.
 */
function HeroRunLedger(): JSX.Element {
  return (
    <div className="fp-run" aria-hidden="true">
      <div className="fp-run__bar">
        <span className="fp-run__id"><span className="fp-run__mark" />{i18n.t('site:heroRunName')}</span>
        <span>{i18n.t('site:heroRunLog')}</span>
      </div>
      <ol className="fp-run__list">
        {RUN_LEDGER.map((row) => (
          <li key={row.event} className={row.waits ? 'fp-run__row fp-run__row--waits' : 'fp-run__row'}>
            <span className="fp-run__at">{row.at}</span>
            <span className="fp-run__event">{row.event}</span>
            <span className="fp-run__gloss">
              {i18n.t(row.gloss)}
              {row.waits ? <span className="fp-run__waits">{i18n.t('site:heroRunWaiting')}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div className="fp-run__foot">{i18n.t('site:heroRunFooter')}</div>
    </div>
  );
}

type HeroVisual = 'workflow' | 'journey' | 'run' | 'image' | 'none';

function resolveHeroVisual(d: Record<string, unknown>): HeroVisual {
  const authored = str(d.visual);
  if (authored === 'workflow' || authored === 'journey' || authored === 'run' || authored === 'image' || authored === 'none') return authored;
  return str(d.imageToken) ? 'image' : 'workflow';
}

function HeroArtwork({ d, visual }: { d: Record<string, unknown>; visual: HeroVisual }): JSX.Element | null {
  if (visual === 'none') return null;
  if (visual === 'journey') return <HeroJourney />;
  if (visual === 'image') {
    const token = str(d.imageToken);
    return token ? <img className="fp-hero__image" src={assetUrl(token)} alt={str(d.alt)} /> : null;
  }
  return <HeroSchematic />;
}

function CtaLink({ label, url, primary }: { label: string; url: string; primary?: boolean }): JSX.Element | null {
  if (!label) return null;
  const cls = `fp-btn ${primary ? 'fp-btn--primary' : 'fp-btn--ghost'}`;
  if (isInternal(url)) return <Link className={cls} to={url}>{label}</Link>;
  if (url && isSafeHref(url)) return <a className={cls} href={url} rel="noopener noreferrer">{label}</a>;
  // SITE-R2-4 — an empty/unsafe URL used to render a button-STYLED <span> that
  // did nothing: unfocusable, unclickable, invisible to keyboard/SR users, yet
  // visually a primary call-to-action. An action nobody can complete must not
  // be offered — render nothing (like an empty label above).
  return null;
}

/** A comparison cell's status class (ADR 0485). The authored glyph itself carries
 *  the meaning, so color is redundant reinforcement — never the sole signal
 *  (DESIGN.md §5.3). Unknown/short-text marks get the neutral cell. */
function compareCellClass(mark: string, highlighted: boolean): string {
  const status = mark === '✓' ? ' fp-matrix__cell--yes'
    : mark === '✗' ? ' fp-matrix__cell--no'
      : mark === '~' ? ' fp-matrix__cell--partial' : '';
  return `fp-matrix__cell${status}${highlighted ? ' fp-matrix__cell--hl' : ''}`;
}

/** The screen-reader word for a status glyph (the glyph alone reads poorly),
 *  localized like the rest of the section. A non-glyph cell (short qualifier
 *  text) is already its own label ⇒ no extra. */
function compareCellAria(mark: string, t: TFunction): string | null {
  if (mark === '✓') return t('comparisonYes', { defaultValue: 'Yes' });
  if (mark === '✗') return t('comparisonNo', { defaultValue: 'No' });
  if (mark === '~') return t('comparisonPartial', { defaultValue: 'Partial' });
  return null;
}

/** Render one section's PUBLIC (front-page) markup. */
function PublicSection({ section }: { section: Section }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  const eyebrow = str(d.eyebrow) || undefined;
  const heading = str(d.heading) || undefined;

  switch (section.type) {
    case 'hero': {
      const visual = resolveHeroVisual(d);
      const copy = (
        <>
          {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
          <h1 className="fp-hero__title">{str(d.heading)}</h1>
          {str(d.subheading) ? <p className="fp-hero__lede">{inlineMarkdown(str(d.subheading), 'hl')}</p> : null}
          {str(d.ctaLabel) || str(d.ctaLabel2) ? (
            <div className="fp-hero__cta">
              <CtaLink label={str(d.ctaLabel)} url={str(d.ctaUrl)} primary />
              <CtaLink label={str(d.ctaLabel2)} url={str(d.ctaUrl2)} />
            </div>
          ) : null}
        </>
      );
      // The run ledger is the hero's subject, not its backdrop: it sits IN the
      // grid beside the copy (and under it on a phone) instead of floating
      // behind it and disappearing below 900px like the other visuals.
      if (visual === 'run') {
        return (
          <section className="cms-public-section fp-hero fp-hero--run">
            <div className="fp-shell fp-hero__inner fp-hero__split">
              <div className="fp-hero__copy">{copy}</div>
              <HeroRunLedger />
            </div>
          </section>
        );
      }
      return (
        <section className={`cms-public-section fp-hero fp-hero--${visual}`}>
          <HeroArtwork d={d} visual={visual} />
          <div className="fp-shell fp-hero__inner">{copy}</div>
        </section>
      );
      }

    case 'richText':
      return (
        <section className="cms-public-section fp-section fp-prose">
          <div className="fp-shell fp-shell--narrow">
            <SectionHead eyebrow={eyebrow} heading={heading} />
            <div className="fp-prose__body"><RichText text={str(d.text)} className="fp-prose__p" /></div>
          </div>
        </section>
      );

    case 'image':
      return (
        <section className="cms-public-section fp-section fp-figure">
          <div className="fp-shell">
            {str(d.token) ? <img className="fp-figure__img" src={assetUrl(str(d.token))} alt={str(d.alt)} /> : null}
            {str(d.caption) ? <p className="fp-figure__cap">{str(d.caption)}</p> : null}
          </div>
        </section>
      );

    case 'cta':
      return (
        <section className="cms-public-section fp-section fp-cta">
          <div className="fp-shell fp-cta__inner">
            {eyebrow ? <p className="fp-eyebrow fp-eyebrow--accent">{eyebrow}</p> : null}
            {heading ? <h2 className="fp-cta__title">{heading}</h2> : null}
            {str(d.subheading) ? <p className="fp-cta__lede">{str(d.subheading)}</p> : null}
            <div className="fp-cta__actions"><CtaLink label={str(d.label)} url={str(d.url)} primary /></div>
          </div>
        </section>
      );

    case 'columns': {
      const cols: { title?: string; text?: string; href?: string; icon?: string; optional?: boolean }[] = Array.isArray(d.columns) ? d.columns : [];
      const layout = str(d.layout) || 'cards';

      if (layout === 'stats') {
        return (
          <section className="cms-public-section fp-section fp-stats">
            <div className="fp-shell">
              <dl className="fp-stats__grid">
                {cols.map((c, i) => (
                  <div key={i} className="fp-stat">
                    <dt className="fp-stat__value">{str(c.title)}</dt>
                    <dd className="fp-stat__label">{str(c.text)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        );
      }
      if (layout === 'rows') {
        // Statement rows: a short claim set large on the left, the plain
        // explanation on the right, one hairline between each. For a set of
        // parallel promises — no numbering (they are not a sequence) and no
        // card chrome (they are one argument, not a menu).
        return (
          <section className="cms-public-section fp-section fp-rows">
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <ul className="fp-rows__list">
                {cols.map((c, i) => (
                  <li key={i} className="fp-row">
                    {str(c.title) ? <h3 className="fp-row__title">{str(c.title)}</h3> : null}
                    <p className="fp-row__text">{inlineMarkdown(str(c.text), `row-${i}`)}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      }
      if (layout === 'steps') {
        return (
          <section className="cms-public-section fp-section fp-steps">
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} />
              <ol className="fp-steps__list">
                {cols.map((c, i) => (
                  <li key={i} className="fp-step">
                    <span className="fp-step__num">{pad2(i + 1)}</span>
                    <div className="fp-step__body">
                      {str(c.title) ? <h3 className="fp-step__title">{str(c.title)}</h3> : null}
                      <p className="fp-step__text">{inlineMarkdown(str(c.text), `step-${i}`)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        );
      }
      if (layout === 'showcase') {
        return (
          <section className="cms-public-section fp-section fp-showcase">
            <div className="fp-shell">
              <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
              <div className="fp-showcase__grid">
                {cols.map((c, i) => {
                  const href = str(c.href);
                  const hasLink = Boolean(href && (isInternal(href) || isSafeHref(href)));
                  const cardInner = (
                    <>
                      <div className="fp-showcase-card__top">
                        <CardGlyph icon={c.icon} i={i} />
                        <span className="fp-showcase-card__index">{pad2(i + 1)}</span>
                      </div>
                      {str(c.title) ? <h3 className="fp-showcase-card__title">{str(c.title)}</h3> : null}
                      <p className="fp-showcase-card__text">{inlineMarkdown(str(c.text), `showcase-${i}`)}</p>
                      {hasLink ? <span className="fp-showcase-card__action">{t('showcaseExplore')} <ArrowRightIcon size={16} /></span> : null}
                    </>
                  );
                  if (href && isInternal(href)) return <Link key={i} to={href} className="fp-showcase-card fp-showcase-card--link">{cardInner}</Link>;
                  if (href && isSafeHref(href)) return <a key={i} href={href} className="fp-showcase-card fp-showcase-card--link" rel="noopener noreferrer">{cardInner}</a>;
                  return <article key={i} className="fp-showcase-card">{cardInner}</article>;
                })}
              </div>
            </div>
          </section>
        );
      }
      return (
        <section className="cms-public-section fp-section fp-cards">
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-cards__grid">
              {cols.map((c, i) => {
                const cardInner = (
                  <>
                    <CardGlyph icon={c.icon} i={i} />
                    {str(c.title) ? <h3 className="fp-card__title">{str(c.title)}</h3> : null}
                    {c.optional ? <span className="fp-card__badge">{t('optionalBadge')}</span> : null}
                    <p className="fp-card__text">{inlineMarkdown(str(c.text), `card-${i}`)}</p>
                  </>
                );
                const href = str(c.href);
                // Whole-card link: ONE anchor per card (no nested links — card text
                // carries no inline link when href is set). Keyboard + semantics free.
                if (href && isInternal(href)) return <Link key={i} to={href} className="fp-card fp-card--link">{cardInner}</Link>;
                if (href && isSafeHref(href)) return <a key={i} href={href} className="fp-card fp-card--link" rel="noopener noreferrer">{cardInner}</a>;
                return <article key={i} className="fp-card">{cardInner}</article>;
              })}
            </div>
          </div>
        </section>
      );
    }

    // C7 (ecommerce gap plan) — validated product REFERENCES resolved live at
    // render time from the public storefront read; a missing/archived product
    // simply doesn't render (the fallback), never stale copied data.
    case 'productGrid':
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 className="fp-h2">{heading}</h2> : null}
            <ProductGridSection storeOrgId={str(d.storeOrgId)} productIds={Array.isArray(d.productIds) ? (d.productIds as unknown[]).filter((x): x is string => typeof x === 'string') : []} />
          </div>
        </section>
      );

    // ADR 0391 (b) — the pricing tier grid. Heading/eyebrow/blurb are authored
    // in the section; the live tier catalog (names + marketing-safe feature/limit
    // lists + optional operator display prices) is fetched from the public
    // billing read at render time — NO price is ever baked into the section or
    // the SPA (billing owns the config; honest-when-unconfigured).
    case 'pricing':
      return (
        <section className="cms-public-section fp-section fp-pricing">
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.blurb) || undefined} />
            <PricingSection
              tierFilter={Array.isArray(d.tiers) ? (d.tiers as unknown[]).filter((x): x is string => typeof x === 'string') : []}
              ctaLabel={str(d.ctaLabel) || undefined}
              ctaUrl={str(d.ctaUrl) || undefined}
            />
          </div>
        </section>
      );

    // ADR 0331 §D2 — a form REFERENCE ({ formId }) resolved live at render
    // time from the public forms read.
    //
    // FORM-UX-4 CORRECTION (ADR 0584): this comment used to end "a
    // missing/unpublished/toggled-off form renders nothing (uniform 404
    // honesty), never a broken page" — and passing no `renderUnavailable` did
    // exactly that. But rendering nothing UNDER AN INTACT EYEBROW AND HEADING is
    // not honesty, it is the false-empty state: the visitor reads "Get in touch"
    // over blank space and cannot tell a removed form from a broken page. The
    // uniform-404 property that genuinely matters is that a DRAFT's existence
    // never leaks, and a generic "this form isn't available" line leaks nothing
    // — it is the same sentence for deleted, unpublished and toggled-off. The
    // renderer now draws that state itself, so this case inherits it.
    case 'form': {
      const formId = str(d.formId);
      if (!formId) return <section className="cms-public-section" />;
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 className="fp-h2">{heading}</h2> : null}
            <Suspense fallback={<div className="u-p-2" role="status"><Skeleton /></div>}>
              <LazyPublicFormRenderer formId={formId} hideTitle={Boolean(heading)} />
            </Suspense>
          </div>
        </section>
      );
    }

    // ADR 0407 D1 — entity-backed sections: a stored QUERY REFERENCE resolved
    // live at render time from the ANONYMOUS public-entities read (publicRead
    // types only — the section can never surface anything the anonymous wire
    // wouldn't). A missing/non-public type renders the fallback (nothing),
    // never stale copied data — the productGrid model.
    case 'entityList':
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 className="fp-h2">{heading}</h2> : null}
            <EntityListSection
              tenantId={str(d.tenantId)} typeName={str(d.typeName)}
              titleField={str(d.titleField)} bodyField={str(d.bodyField) || undefined}
              limit={typeof d.limit === 'number' ? d.limit : 6}
              sortKey={str(d.sortKey) || undefined}
              sortDir={d.sortDir === 'asc' || d.sortDir === 'desc' ? d.sortDir : undefined}
              termId={str(d.termId) || undefined}
              filterKey={str(d.filterKey) || undefined}
              filterValue={str(d.filterValue) || undefined}
            />
          </div>
        </section>
      );

    case 'entityDetail':
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            {eyebrow ? <p className="fp-eyebrow">{eyebrow}</p> : null}
            {heading ? <h2 className="fp-h2">{heading}</h2> : null}
            <EntityDetailSection
              tenantId={str(d.tenantId)} typeName={str(d.typeName)} entityId={str(d.entityId)}
              titleField={str(d.titleField)} bodyField={str(d.bodyField) || undefined}
            />
          </div>
        </section>
      );

    // ADR 0485 — a capability comparison MATRIX. All cells are short authored
    // status tokens (text, never HTML/links); rows = capabilities, columns =
    // named products. The wide table scrolls inside its own region (never the
    // page body); each glyph cell carries an sr-only word so it isn't color-
    // or symbol-only to assistive tech.
    case 'comparison': {
      const columns: string[] = Array.isArray(d.columns)
        ? (d.columns as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      const rows: { label: string; cells: string[] }[] = Array.isArray(d.rows)
        ? (d.rows as unknown[]).map((r) => {
          const rr = r as { label?: unknown; cells?: unknown };
          return {
            label: str(rr.label),
            cells: Array.isArray(rr.cells) ? (rr.cells as unknown[]).map(str) : [],
          };
        }).filter((r) => r.label.length > 0)
        : [];
      if (columns.length === 0 || rows.length === 0) return <section className="cms-public-section" />;
      const highlight = typeof d.highlightColumn === 'number' ? d.highlightColumn : -1;
      const legend = str(d.legend);
      const note = str(d.note);
      return (
        <section className="cms-public-section fp-section fp-matrix">
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-matrix__scroll" role="region" aria-label={heading || t('comparisonRegion', { defaultValue: 'Comparison matrix' })} tabIndex={0}>
              <table className="fp-matrix__table">
                <thead>
                  <tr>
                    <td className="fp-matrix__corner" />
                    {columns.map((c, i) => (
                      <th key={i} scope="col" className={i === highlight ? 'fp-matrix__colhead fp-matrix__colhead--hl' : 'fp-matrix__colhead'}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      <th scope="row" className="fp-matrix__rowhead">{row.label}</th>
                      {columns.map((_, ci) => {
                        const v = str(row.cells[ci]);
                        // A11Y-2 — an under-authored row (cells shorter than
                        // columns) used to render a truly BLANK cell: nothing
                        // for a screen reader, ambiguity for everyone else.
                        // An absent cell claims nothing — "not specified".
                        if (!v.trim()) {
                          return (
                            <td key={ci} className={compareCellClass('', ci === highlight)}>
                              <span aria-hidden="true" className="fp-matrix__mark">—</span>
                              <span className="sr-only">{t('pricingCompareUnspecified', { defaultValue: 'Not specified' })}</span>
                            </td>
                          );
                        }
                        const aria = compareCellAria(v, t);
                        return (
                          <td key={ci} className={compareCellClass(v, ci === highlight)}>
                            <span aria-hidden={aria ? true : undefined} className="fp-matrix__mark">{v}</span>
                            {aria ? <span className="sr-only">{aria}</span> : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {legend ? <p className="fp-matrix__legend">{legend}</p> : null}
            {note ? <p className="fp-matrix__note">{note}</p> : null}
          </div>
        </section>
      );
    }

    case 'faq': {
      // R2-G10 — authored Q/A on native <details>/<summary>: keyboard + SR
      // support for free, no JS state, and the prerender emits FAQPage JSON-LD
      // from the same validated data.
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((it) => ({ q: str((it as { q?: unknown }).q), a: str((it as { a?: unknown }).a) }))
        .filter((it) => it.q && it.a);
      if (items.length === 0) return <section className="cms-public-section" />;
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-faq">
              {items.map((it, i) => (
                <details key={i} className="fp-faq__item">
                  <summary className="fp-faq__q">{it.q}</summary>
                  <p className="fp-faq__a">{it.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      );
    }

    case 'fields': {
      // ADR 0748 — protocol-authored named fields: a definition list, every key
      // and value rendered as TEXT (never markup, never a link). No SectionHead —
      // a field called `heading` is data the author named, not page structure.
      const rows = Object.entries(d)
        .map(([k, v]) => [k, typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''] as const)
        .filter(([, v]) => v !== '');
      if (rows.length === 0) return <section className="cms-public-section" />;
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            <dl className="fp-fields">
              {rows.map(([k, v]) => (
                <Fragment key={k}><dt className="fp-fields__k">{k}</dt><dd className="fp-fields__v">{v}</dd></Fragment>
              ))}
            </dl>
          </div>
        </section>
      );
    }

    case 'quotes': {
      // R2-G10 — attributed social proof. Real <figure>/<blockquote> semantics;
      // an unattributed quote renders with no byline — never an invented one.
      const items = (Array.isArray(d.items) ? d.items : [])
        .map((it) => {
          const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
          return { quote: str(ii.quote), name: str(ii.name), role: str(ii.role) };
        })
        .filter((it) => it.quote);
      if (items.length === 0) return <section className="cms-public-section" />;
      return (
        <section className="cms-public-section">
          <div className="fp-shell">
            <SectionHead eyebrow={eyebrow} heading={heading} lede={str(d.lede) || undefined} />
            <div className="fp-quotes">
              {items.map((it, i) => (
                <figure key={i} className="fp-quote">
                  <blockquote className="fp-quote__text"><p>{it.quote}</p></blockquote>
                  {it.name || it.role ? (
                    <figcaption className="fp-quote__byline">
                      {it.name ? <span className="fp-quote__name">{it.name}</span> : null}
                      {it.name && it.role ? <span aria-hidden="true"> · </span> : null}
                      {it.role ? <span className="fp-quote__role">{it.role}</span> : null}
                    </figcaption>
                  ) : null}
                </figure>
              ))}
            </div>
          </div>
        </section>
      );
    }

    default:
      return <section className="cms-public-section" />;
  }
}

/** The anonymous public-entities wire shape (ADR 0407 D2 projection). */
interface PublicEntityRow {
  entityId: string;
  values: Record<string, string | number | boolean>;
}

const publicEntityValue = (row: PublicEntityRow, field: string): string => {
  const v = row.values?.[field]; // guard a wire row missing `values` (pricing-'*' class)
  return v === undefined || v === null ? '' : String(v);
};

/** Live entity rows for the entityList section (one anonymous read per render). */
function EntityListSection({ tenantId, typeName, titleField, bodyField, limit, sortKey, sortDir, termId, filterKey, filterValue }: {
  tenantId: string; typeName: string; titleField: string; bodyField?: string | undefined;
  limit: number; sortKey?: string | undefined; sortDir?: 'asc' | 'desc' | undefined; termId?: string | undefined;
  filterKey?: string | undefined; filterValue?: string | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('cms');
  const [rows, setRows] = useState<PublicEntityRow[] | null>(null);
  // A failed read is NOT an empty list. Collapsing the two rendered `null`,
  // which on a PUBLIC page silently deletes a whole configured section: the
  // visitor sees a short page, and the operator gets no signal at all. Same
  // separation `PricingSection` already makes below.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!tenantId || !typeName || !titleField) { setRows([]); return; }
    const params = new URLSearchParams({ limit: String(limit) });
    if (sortKey) { params.set('sortKey', sortKey); if (sortDir) params.set('sortDir', sortDir); }
    if (termId) params.set('termId', termId);
    if (filterKey && filterValue) params.set('filters', JSON.stringify([{ key: filterKey, op: 'eq', value: filterValue }]));
    void fetch(`${config.baseUrl}/host/openwop-app/public-entities/${encodeURIComponent(tenantId)}/types/${encodeURIComponent(typeName)}/entities?${params}`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { entities: PublicEntityRow[] }; })
      // Guard the wire shape: a 200 with a non-array `entities` would slip the
      // `rows.length` check and crash `rows.map` in render (outside this catch) —
      // the pricing-'*' crash class. Narrow to an array (empty ⇒ the null fallback).
      .then((r) => { setError(false); setRows(Array.isArray(r.entities) ? r.entities : []); })
      .catch(() => { setError(true); setRows([]); });
  }, [tenantId, typeName, titleField, limit, sortKey, sortDir, termId, filterKey, filterValue]);
  if (error) return <p className="fp-pricing__note">{t('sectionLoadError', { defaultValue: 'Couldn’t load this section.' })}</p>;
  if (!rows || rows.length === 0) return null; // a section that legitimately matches nothing stays silent
  return (
    <div className="card-grid">
      {rows.map((row) => {
        const title = publicEntityValue(row, titleField);
        const body = bodyField ? publicEntityValue(row, bodyField) : '';
        if (!title) return null;
        return (
          <article key={row.entityId} className="surface-card u-p-4 u-grid u-gap-2">
            <strong>{title}</strong>
            {body ? <p className="u-m-0 u-text-sm muted">{body}</p> : null}
          </article>
        );
      })}
    </div>
  );
}

/** One live entity for the entityDetail section (the entityList rules, one row). */
function EntityDetailSection({ tenantId, typeName, entityId, titleField, bodyField }: {
  tenantId: string; typeName: string; entityId: string; titleField: string; bodyField?: string | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('cms');
  const [row, setRow] = useState<PublicEntityRow | null | 'missing'>(null);
  // A failed read is NOT a missing entity (same separation as EntityListSection
  // above — this was the one sibling the sweep missed, SITE-R2-3): a 500 used to
  // silently delete a pinned case-study section from the page.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!tenantId || !typeName || !entityId) { setRow('missing'); return; }
    void fetch(`${config.baseUrl}/host/openwop-app/public-entities/${encodeURIComponent(tenantId)}/types/${encodeURIComponent(typeName)}/entities/${encodeURIComponent(entityId)}`, fetchOpts({}))
      .then(async (r) => {
        if (r.status === 404 || r.status === 410) return 'missing' as const;
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as PublicEntityRow;
      })
      .then((v) => { setError(false); setRow(v); })
      .catch(() => setError(true));
  }, [tenantId, typeName, entityId]);
  if (error) return <p className="fp-pricing__note">{t('sectionLoadError', { defaultValue: 'Couldn’t load this section.' })}</p>;
  if (row === null || row === 'missing') return null;
  const title = publicEntityValue(row, titleField);
  if (!title) return null;
  const body = bodyField ? publicEntityValue(row, bodyField) : '';
  return (
    <article className="surface-card u-p-4 u-grid u-gap-2">
      <strong>{title}</strong>
      {body ? <p className="u-m-0 muted">{body}</p> : null}
    </article>
  );
}

/** Live product refs for the productGrid section (one public read per page render). */
function ProductGridSection({ storeOrgId, productIds }: { storeOrgId: string; productIds: string[] }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const [products, setProducts] = useState<{ productId: string; name: string; description?: string; price: number; currency: string; imageAssetTokens: string[] }[] | null>(null);
  // See EntityListSection: an unreadable grid used to vanish, taking its Shop
  // CTAs with it — a revenue surface disappearing with nothing to notice.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!storeOrgId) { setProducts([]); return; }
    void fetch(`${config.baseUrl}/host/openwop-app/public-store/${encodeURIComponent(storeOrgId)}/products`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { products: { productId: string; name: string; description?: string; price: number; currency: string; imageAssetTokens: string[] }[] }; })
      .then((r) => { setError(false); setProducts((Array.isArray(r.products) ? r.products : []).filter((pp) => productIds.includes(pp.productId))); })
      .catch(() => { setError(true); setProducts([]); });
    // productIds is a fresh array per render — key on its content, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeOrgId, productIds.join(',')]);
  if (error) return <p className="fp-pricing__note">{t('productGridLoadError', { defaultValue: 'Couldn’t load these products.' })}</p>;
  if (!products || products.length === 0) return null; // a grid that legitimately matches nothing stays silent
  return (
    <div className="card-grid">
      {products.map((pp) => (
        <article key={pp.productId} className="surface-card u-p-4 u-grid u-gap-2">
          {pp.imageAssetTokens[0] ? <img src={assetUrl(pp.imageAssetTokens[0])} alt="" className="cms-hero-img" /> : null}
          <strong>{pp.name}</strong>
          {pp.description ? <p className="u-m-0 u-text-sm muted">{pp.description}</p> : null}
          <div className="action-bar u-justify-between u-items-center">
            <strong>{fmt.currency(pp.price, pp.currency)}</strong>
            <Link className="fp-btn fp-btn--primary" to={`/store/${encodeURIComponent(storeOrgId)}`}>{t('productGridShop', { defaultValue: 'Shop' })}</Link>
          </div>
        </article>
      ))}
    </div>
  );
}

/** One tier in the public pricing catalog (ADR 0391 §b). Marketing-safe only —
 *  the read NEVER leaks `stripePriceId` or entitlements. `display` is present
 *  only when the operator configured `OPENWOP_BILLING_PLAN_DISPLAY`. */
interface PublicTier {
  tier: string;
  name: string;
  // '*' = unrestricted (all features) — the billing wire sentinel
  // (`PublicPricingTier.features: '*' | string[]`); NOT always an array.
  features?: '*' | string[];
  limits?: Record<string, unknown>;
  display?: {
    price?: string; cadence?: string; blurb?: string; highlighted?: boolean;
    // R2-G7 — the additive annual price shape; all operator-authored strings.
    priceAnnual?: string; cadenceAnnual?: string; annualNote?: string;
  };
}

/** Live tier grid for the pricing section (one public read per render). Renders
 *  a real display price ONLY when configured; otherwise the tier name + its
 *  feature/limit list + a neutral CTA — it NEVER fabricates a dollar figure. */
interface PublicBundle { bundleId: string; label: string; priceDisplay?: { price?: string; cadence?: string; blurb?: string } }

/**
 * UX_UPGRADE-site G5 — the plan-COMPARISON view. The tier cards each list their
 * own features, which leaves a visitor to diff three independent lists by eye;
 * a comparison matrix is core 2026 pricing practice. Built entirely from the
 * SAME `tiers[].features` the cards render (union of feature strings × tier,
 * ✓ / —), so the table can never disagree with the cards above it and no new
 * authoring surface or billing config is introduced.
 *
 * Renders only when there is something to compare (≥2 tiers AND ≥1 feature).
 * Mobile is ~58% of pricing traffic, so the table scrolls inside its OWN
 * container (`.fp-compare__scroll`) — the page body never scrolls sideways.
 */
function TierComparison({ tiers }: { tiers: PublicTier[] }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  // A page may carry more than one `pricing` section, so the heading id must be
  // instance-unique — a duplicate id would silently break both aria-labelledby
  // references.
  const headingId = useId();
  // Only ARRAY feature lists contribute named rows. A `'*'` tier (unrestricted —
  // all features) is handled per-cell below; iterating it here would add its
  // characters as bogus feature rows (`for..of '*'`), and String membership would
  // mismark it — so guard on Array.isArray.
  const rows = ((): string[] => {
    const seen = new Set<string>();
    for (const tt of tiers) {
      if (!Array.isArray(tt.features)) continue;
      for (const f of tt.features) if (typeof f === 'string' && f.trim()) seen.add(f);
    }
    return [...seen];
  })();
  // R2-G5 (DISCARD-1): the tiers' USAGE LIMITS ride the same payload and are the
  // concrete differentiator (Free vs Pro with identical feature lists but 10×
  // caps looked identical). Union of limit keys → one row each, cells = the
  // locale-formatted number. The config declares NO period/unit, so none is
  // invented (the currency/unit doctrine); an absent key renders as
  // "not specified" — the payload cannot distinguish "unlimited" from
  // "unconfigured", so the cell must not claim either.
  const limitRows = ((): string[] => {
    const seen = new Set<string>();
    for (const tt of tiers) {
      if (!tt.limits || typeof tt.limits !== 'object') continue;
      for (const [k, v] of Object.entries(tt.limits)) {
        if (typeof v === 'number' && Number.isFinite(v) && k.trim()) seen.add(k);
      }
    }
    return [...seen];
  })();
  if (tiers.length < 2 || (rows.length === 0 && limitRows.length === 0)) return null;
  return (
    <section className="fp-compare" aria-labelledby={headingId}>
      <h3 id={headingId} className="fp-compare__title">{t('pricingCompareTitle', { defaultValue: 'Compare plans' })}</h3>
      <div className="fp-compare__scroll" tabIndex={0} role="region" aria-labelledby={headingId}>
        <table className="fp-compare__table">
          <caption className="sr-only">{t('pricingCompareCaption', { defaultValue: 'Which features each plan includes' })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('pricingCompareFeature', { defaultValue: 'Feature' })}</th>
              {tiers.map((tt) => <th key={tt.tier} scope="col">{tt.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((feature) => (
              <tr key={feature}>
                <th scope="row">{humanizeFeatureId(feature)}</th>
                {tiers.map((tt) => {
                  // '*' = unrestricted ⇒ the tier includes EVERY feature.
                  const has = tt.features === '*' || (Array.isArray(tt.features) && tt.features.includes(feature));
                  return (
                    <td key={tt.tier} className={has ? 'fp-compare__yes' : 'fp-compare__no'}>
                      <span aria-hidden="true">{has ? '✓' : '—'}</span>
                      <span className="sr-only">{has
                        ? t('pricingCompareIncluded', { defaultValue: 'Included' })
                        : t('pricingCompareNotIncluded', { defaultValue: 'Not included' })}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
            {limitRows.map((key) => (
              <tr key={`limit:${key}`}>
                <th scope="row">{humanizeFeatureId(key)}</th>
                {tiers.map((tt) => {
                  const v = tt.limits && typeof tt.limits === 'object' ? (tt.limits as Record<string, unknown>)[key] : undefined;
                  const isNum = typeof v === 'number' && Number.isFinite(v);
                  return (
                    <td key={tt.tier} className={isNum ? 'fp-compare__num' : 'fp-compare__no'}>
                      {isNum
                        ? <span>{fmt.number(v)}</span>
                        : <>
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">{t('pricingCompareUnspecified', { defaultValue: 'Not specified' })}</span>
                          </>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PricingSection({ tierFilter, ctaLabel, ctaUrl }: { tierFilter: string[]; ctaLabel?: string | undefined; ctaUrl?: string | undefined }): JSX.Element {
  const { t } = useTranslation('cms');
  const [tiers, setTiers] = useState<PublicTier[] | null>(null);
  const [bundles, setBundles] = useState<PublicBundle[]>([]); // ADR 0419 — for-sale add-on bundles
  const [bundlesFailed, setBundlesFailed] = useState(false); // READ-1 — failed ≠ none configured
  const [error, setError] = useState(false);
  // R2-G7 — billing-period toggle. Annual is the default when it exists (the
  // dominant 2026 pattern); with no annual price authored anywhere the toggle
  // never renders and the single-price render stands (the Linear pattern).
  const [period, setPeriod] = useState<'monthly' | 'annual'>('annual');
  useEffect(() => {
    let live = true;
    void fetch(`${config.baseUrl}/host/openwop-app/public/pricing`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as { tiers: PublicTier[] }; })
      .then((r) => { if (live) setTiers(Array.isArray(r.tiers) ? r.tiers : []); })
      .catch(() => { if (live) setError(true); });
    // Bundle add-ons (ADR 0419) — genuinely-unconfigured (404 / empty) ⇒ nothing
    // shown; a FAILED read is not "no bundles" (READ-1: a 500 silently removed a
    // priced revenue surface). It still never blocks the tier grid — the failure
    // renders as a note in the add-ons slot, not an error page.
    void fetch(`${config.baseUrl}/host/openwop-app/public/bundle-pricing`, fetchOpts({}))
      .then(async (r) => {
        if (r.status === 404) return { bundles: [] as PublicBundle[] };
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { bundles: PublicBundle[] };
      })
      .then((r) => { if (live) { setBundlesFailed(false); setBundles(Array.isArray(r.bundles) ? r.bundles : []); } })
      .catch(() => { if (live) setBundlesFailed(true); });
    return () => { live = false; };
  }, []);

  if (error) return <p className="fp-pricing__note">{t('pricingLoadError', { defaultValue: 'Couldn’t load pricing.' })}</p>;
  if (!tiers) return <div className="u-p-2" role="status"><Skeleton /></div>;
  // The section may name WHICH tiers to show (in order); empty ⇒ all, as returned.
  const shown = tierFilter.length > 0
    ? tierFilter.map((k) => tiers.find((x) => x.tier === k)).filter((x): x is PublicTier => Boolean(x))
    : tiers;
  if (shown.length === 0) return <p className="fp-pricing__note">{t('pricingEmpty', { defaultValue: 'No plans configured yet.' })}</p>;

  const hasAnnual = shown.some((tt) => tt.display?.priceAnnual);
  const annual = hasAnnual && period === 'annual';
  // The toggle-level note is the operator's OWN discount claim, rendered
  // verbatim — never a computed percentage. First authored one wins.
  const annualNote = shown.map((tt) => tt.display?.annualNote).find((n) => n);

  return (
    <>
      {hasAnnual ? (
        <div className="fp-pricing__period" role="group" aria-label={t('pricingBillingPeriodLabel', { defaultValue: 'Billing period' })}>
          <button
            type="button" className="fp-period__btn" aria-pressed={!annual}
            onClick={() => setPeriod('monthly')}
          >{t('pricingPayMonthly', { defaultValue: 'Pay monthly' })}</button>
          <button
            type="button" className="fp-period__btn" aria-pressed={annual}
            onClick={() => setPeriod('annual')}
          >{t('pricingPayAnnual', { defaultValue: 'Pay yearly' })}</button>
          {annualNote ? <span className="fp-pricing__period-note">{annualNote}</span> : null}
        </div>
      ) : null}
      <div className="fp-pricing__grid">
        {shown.map((tt) => {
          // Annual mode shows a tier's authored annual price; a tier WITHOUT one
          // keeps its single authored price + ITS OWN cadence string (which
          // discloses the period) — never a relabeled number.
          const useAnnual = annual && Boolean(tt.display?.priceAnnual);
          const price = useAnnual ? tt.display?.priceAnnual : tt.display?.price;
          const cadence = useAnnual ? tt.display?.cadenceAnnual : tt.display?.cadence;
          // '*' = unrestricted (all features). A guarded read: `?? []` does NOT
          // catch the `'*'` sentinel (a non-null string), so filter blindly
          // used to CRASH the whole pricing page on an unrestricted tier. Show a
          // single "everything" bullet for '*'; a real list otherwise; never throw.
          const allFeatures = tt.features === '*';
          const features = Array.isArray(tt.features) ? tt.features.filter((f) => typeof f === 'string') : [];
          return (
            <article key={tt.tier} className={`fp-tier${tt.display?.highlighted ? ' fp-tier--highlighted' : ''}`}>
              {tt.display?.highlighted ? <span className="fp-tier__badge">{t('pricingPopular', { defaultValue: 'Popular' })}</span> : null}
              <h3 className="fp-tier__name">{tt.name}</h3>
              {price ? (
                <p className="fp-tier__price">{price}{cadence ? <span className="fp-tier__cadence">{cadence}</span> : null}</p>
              ) : (
                <p className="fp-tier__price fp-tier__price--none">{t('pricingContactPrice', { defaultValue: 'Let’s talk' })}</p>
              )}
              {tt.display?.blurb ? <p className="fp-tier__blurb">{tt.display.blurb}</p> : null}
              {allFeatures ? (
                <ul className="fp-tier__features">
                  <li>{t('pricingAllFeatures', { defaultValue: 'Everything included' })}</li>
                </ul>
              ) : features.length > 0 ? (
                <ul className="fp-tier__features">
                  {features.slice(0, FEATURE_CARD_CAP).map((f) => <li key={f}>{humanizeFeatureId(f)}</li>)}
                  {features.length > FEATURE_CARD_CAP ? (
                    <li className="fp-tier__features-more">{t('pricingMoreFeatures', { defaultValue: 'and {{n}} more', n: features.length - FEATURE_CARD_CAP })}</li>
                  ) : null}
                </ul>
              ) : null}
              <CtaLink label={ctaLabel || t('pricingCta', { defaultValue: 'Get started' })} url={ctaUrl || '/chat'} primary={Boolean(tt.display?.highlighted)} />
            </article>
          );
        })}
      </div>
      <TierComparison tiers={shown} />
      {/* ADR 0419 — for-sale add-on bundles (marketing facts, no Stripe id). Only
          shown when the operator has priced a bundle; anon page ⇒ display only,
          the Buy flow lives in the authed workspace store. */}
      {bundlesFailed ? (
        <p className="fp-pricing__note">{t('bundlePricingLoadError', { defaultValue: 'Couldn’t load add-on bundles.' })}</p>
      ) : null}
      {bundles.length > 0 ? (
        <div className="fp-pricing__addons">
          <h3 className="fp-pricing__addons-title">{t('pricingAddonsTitle', { defaultValue: 'Add-on feature bundles' })}</h3>
          {/* UX-419C — the cards are display-only (identical .fp-tier chrome to the
              actionable plan cards above), so orient the visitor on where to buy. */}
          <p className="fp-pricing__addons-note">{t('pricingAddonsNote', { defaultValue: 'Purchase add-ons from your workspace store.' })}</p>
          <div className="fp-pricing__grid">
            {bundles.map((b) => (
              <article key={b.bundleId} className="fp-tier">
                {/* UX-419A — h4 so the "Add-on feature bundles" h3 above outranks
                    the bundle names it groups (a group header must not sit at its items' level). */}
                <h4 className="fp-tier__name">{b.label}</h4>
                {b.priceDisplay?.price ? (
                  <p className="fp-tier__price">{b.priceDisplay.price}{b.priceDisplay.cadence ? <span className="fp-tier__cadence">{b.priceDisplay.cadence}</span> : null}</p>
                ) : null}
                {b.priceDisplay?.blurb ? <p className="fp-tier__blurb">{b.priceDisplay.blurb}</p> : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The simple editor preview (markup kept rough — the public page is `.fp-*`). */
function EditorPreview({ section }: { section: Section }): JSX.Element {
  const { t } = useTranslation('cms');
  const d = section.data;
  switch (section.type) {
    case 'hero':
      return (
        <div className="cms-hero-preview">
          {str(d.imageToken) ? <img src={assetUrl(str(d.imageToken))} alt="" className="cms-hero-img" /> : null}
          {str(d.eyebrow) ? <span className="u-label-sm">{str(d.eyebrow)}</span> : null}
          <strong className="cms-hero-heading">{str(d.heading)}</strong>
          {str(d.subheading) ? <span className="u-label-sm">{str(d.subheading)}</span> : null}
        </div>
      );
    case 'richText':
      return <RichText text={str(d.text)} />;
    case 'image':
      return str(d.token)
        ? <img src={assetUrl(str(d.token))} alt={str(d.alt)} className="cms-img" />
        : <span className="u-label-sm">{t('noImage')}</span>;
    case 'cta':
      return <span className="chip chip--accent">{str(d.heading) || str(d.label)}</span>;
    case 'columns': {
      const cols: { title?: string; text?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      return (
        <div className="cms-columns" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, 1fr)` }}>
          {cols.map((c, i) => <div key={i} className="cms-column-cell">{str(c.title) ? <strong>{str(c.title)} · </strong> : null}{str(c.text)}</div>)}
        </div>
      );
    }
    case 'productGrid':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong>{str(d.heading)}</strong> : null}
          <span className="u-label-sm">{t('productGridPreview', { defaultValue: '{{count}} product(s) from the storefront', count: Array.isArray(d.productIds) ? (d.productIds as unknown[]).length : 0 })}</span>
        </div>
      );
    case 'form':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong>{str(d.heading)}</strong> : null}
          <span className="u-label-sm">{str(d.formId) ? t('formSectionPreview', { defaultValue: 'Form: {{id}}', id: str(d.formId) }) : t('formSectionEmpty', { defaultValue: 'No form selected' })}</span>
        </div>
      );
    case 'pricing':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong>{str(d.heading)}</strong> : null}
          <span className="u-label-sm">{t('pricingSectionPreview', { defaultValue: 'Pricing tiers ({{n}})', n: Array.isArray(d.tiers) ? (d.tiers as unknown[]).length : 0 })}</span>
        </div>
      );
    case 'comparison':
      return (
        <div className="u-grid u-gap-1">
          {str(d.heading) ? <strong>{str(d.heading)}</strong> : null}
          <span className="u-label-sm">{t('comparisonSectionPreview', {
            defaultValue: 'Comparison matrix ({{r}} rows × {{c}} columns)',
            r: Array.isArray(d.rows) ? (d.rows as unknown[]).length : 0,
            c: Array.isArray(d.columns) ? (d.columns as unknown[]).length : 0,
          })}</span>
        </div>
      );
    case 'fields': {
      const keys = Object.keys(d);
      return (
        <div className="u-grid u-gap-1">
          {keys.length === 0
            ? <span className="u-label-sm">{t('fieldsEmpty')}</span>
            : <span className="u-label-sm">{keys.slice(0, 6).join(' · ')}{keys.length > 6 ? ' …' : ''}</span>}
        </div>
      );
    }
    default:
      return <span className="u-label-sm">{t('unknownSection')}</span>;
  }
}

/** Render one typed section in editor or public mode. */
export function RenderSection({ section, mode = 'editor' }: { section: Section; mode?: SectionRenderMode }): JSX.Element {
  return mode === 'public' ? <PublicSection section={section} /> : <EditorPreview section={section} />;
}

/** Render an ordered list of sections.
 *
 * `onEditSection` (CMS preview only — the live public page never passes it)
 * turns each section into a click-through target: a hover/focus-revealed
 * "Edit" affordance that jumps to that section's editor card (the Storyblok
 * block↔preview contract, adapted: the preview's own links/buttons keep
 * working, so the affordance is an overlay chip, not a whole-block hijack).
 * The wrapper div exists ONLY on this path — the public page's markup (and
 * its `.cms-public-page > .cms-public-section` stagger) is untouched. */
export function RenderSections({ sections, mode = 'editor', onEditSection }: {
  sections: Section[];
  mode?: SectionRenderMode;
  onEditSection?: (sectionId: string) => void;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const list = Array.isArray(sections) ? sections : [];
  if (!onEditSection) return <>{list.map((s) => <RenderSection key={s.sectionId} section={s} mode={mode} />)}</>;
  return (
    <>
      {list.map((s) => (
        <div key={s.sectionId} className="cms-pv-section" data-section-id={s.sectionId}>
          <RenderSection section={s} mode={mode} />
          <Button
            variant="secondary"
            size="sm"
            className="cms-pv-edit"
            aria-label={t('editSectionAria', { type: s.type })}
            onClick={() => onEditSection(s.sectionId)}
          >
            <PencilIcon /> {t('editSectionAction')}
          </Button>
        </div>
      ))}
    </>
  );
}
