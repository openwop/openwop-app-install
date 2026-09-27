/**
 * The generic `app.*` typed-artifact renderer (ADR 0346 4c) — ONE schema-blind
 * structured view for the App Builder pipeline's typed deliverables
 * (`app.research` today; `app.prd`/`app.plan`/`app.audit` as their producers
 * land in 4d). Registered with a `match` predicate so a NEW `app.*` type gets
 * a readable inline preview without a bespoke component — the anti-"inert
 * Markdown fallback" gap the ADR 0346 audit recorded.
 *
 * SAFETY: pure data rendering — every value lands as React-escaped text;
 * objects/arrays recurse with a hard depth cap; nothing executes.
 */
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

const MAX_DEPTH = 4;
const MAX_ITEMS = 25;

const labelize = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Value({ value, depth }: { value: unknown; depth: number }): JSX.Element {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }
  if (depth >= MAX_DEPTH) return <span className="muted">…</span>;
  if (Array.isArray(value)) {
    return (
      <ul className="app-facet__list">
        {value.slice(0, MAX_ITEMS).map((v, i) => <li key={i}><Value value={v} depth={depth + 1} /></li>)}
        {value.length > MAX_ITEMS ? <li className="muted">…</li> : null}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS);
  return (
    <dl className="app-facet__dl">
      {entries.map(([k, v]) => (
        <div key={k} className="app-facet__row">
          <dt>{labelize(k)}</dt>
          <dd><Value value={v} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  );
}

export function AppFacetArtifactView({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <Notice variant="error">{t('appFacetInvalid')}</Notice>;
  }
  return (
    <div className="app-facet">
      {Object.entries(parsed as Record<string, unknown>).map(([section, value]) => (
        <section key={section} className="app-facet__section">
          <h4 className="app-facet__title">{labelize(section)}</h4>
          <Value value={value} depth={0} />
        </section>
      ))}
    </div>
  );
}
