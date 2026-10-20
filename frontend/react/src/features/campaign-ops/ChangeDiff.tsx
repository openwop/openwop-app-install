/**
 * Before → after for one change (ADR 0926 D1). Per page, per field; the changed
 * span is marked with `<del>` / `<ins>` around the part between the common
 * prefix and suffix, so a one-word edit in a long headline is visible at a
 * glance. Plain text only — never `dangerouslySetInnerHTML`.
 */
import { useTranslation } from 'react-i18next';
import type { DiffEntry } from './campaignOpsClient.js';

/** Splits `before`/`after` into shared prefix, the two changed middles, and shared suffix. */
export function splitChange(before: string, after: string): { prefix: string; removed: string; added: string; suffix: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < max - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end += 1;
  return {
    prefix: before.slice(0, start),
    removed: before.slice(start, before.length - end),
    added: after.slice(start, after.length - end),
    suffix: before.slice(before.length - end),
  };
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function ChangeDiff({ diff }: { diff: DiffEntry[] }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const entries = diff.filter((d) => d.fields.length > 0);
  if (entries.length === 0) return <p className="u-text-muted u-fs-13 u-m-0">{t('diffEmpty')}</p>;
  return (
    <ul className="u-list-plain u-grid u-gap-2 u-m-0">
      {entries.map((entry) => (
        <li key={entry.assetId} className="u-grid u-gap-1">
          <strong className="u-fs-13">{entry.label}</strong>
          <ul className="u-list-plain u-grid u-gap-2 u-m-0">
            {entry.fields.map((f) => {
              const before = asText(f.before);
              const after = asText(f.after);
              const s = splitChange(before, after);
              const empty = t('diffEmptyValue');
              return (
                <li key={f.field} className="u-grid u-gap-1 u-fs-13">
                  <span className="u-text-muted u-fs-12">{t('diffField', { field: f.field })}</span>
                  <dl className="u-grid u-gap-1 u-m-0">
                    <div className="u-flex u-gap-2">
                      <dt className="u-text-muted u-shrink-0">{t('diffBefore')}</dt>
                      <dd className="u-m-0 u-prewrap u-break-anywhere">
                        {before ? <>{s.prefix}{s.removed ? <del className="u-text-danger">{s.removed}</del> : null}{s.suffix}</> : <span className="u-text-muted">{empty}</span>}
                      </dd>
                    </div>
                    <div className="u-flex u-gap-2">
                      <dt className="u-text-muted u-shrink-0">{t('diffAfter')}</dt>
                      <dd className="u-m-0 u-prewrap u-break-anywhere">
                        {after ? <>{s.prefix}{s.added ? <ins className="u-text-success">{s.added}</ins> : null}{s.suffix}</> : <span className="u-text-muted">{empty}</span>}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
