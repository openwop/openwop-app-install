/**
 * ADR 1060 — the editor fields for the illustrated hero visuals, built from
 * the same spec the validator enforces (`heroArtSpec.ts`): a text input per
 * text field (its `maxLength` is the server's cap), a fieldset per nested
 * object, and a repeatable card per list item with an Add button that stops at
 * the list's cap (the server refuses one more, it never cuts).
 *
 * Styling fields (a state, an accent, a fill, a count) are presentation: like
 * the ADR 1038 flow's mark picker they are offered on the base layer only, and
 * a translation's copy follows the base on save (`restoreItemStates`).
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { formatNumber } from '../../i18n/format.js';
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { HERO_ART_SPECS, type ArtField, type ArtShape, type HeroArtVisual } from './heroArtSpec.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** A field's label key, by field name (shared across visuals). */
const FIELD_LABELS: Record<string, string> = {
  label: 'artFieldCaption',
  title: 'artFieldTitle',
  subtitle: 'artFieldSubtitle',
  amount: 'artFieldAmount',
  state: 'artFieldState',
  totalLabel: 'artFieldTotalLabel',
  totalAmount: 'artFieldTotalAmount',
  stamp: 'artFieldStamp',
  chip: 'artFieldChip',
  name: 'artFieldName',
  address: 'artFieldAddress',
  accent: 'artFieldAccent',
  heading: 'artFieldHeading',
  text: 'artFieldText',
  status: 'artFieldStatus',
  divider: 'artFieldDivider',
  before: 'artFieldBefore',
  after: 'artFieldAfter',
  source: 'artFieldSource',
  check: 'artFieldCheck',
  time: 'artFieldTime',
  day: 'artFieldDay',
  reply: 'artFieldReply',
  primary: 'artFieldPrimary',
  secondary: 'artFieldSecondary',
  members: 'artFieldMembers',
  value: 'artFieldValue',
  fill: 'artFieldFill',
  event: 'artFieldEvent',
  detail: 'artFieldDetail',
};

/** A list's item noun ("Line 2") and its Add button, by `visual.key`. */
const LIST_LABELS: Record<string, { item: string; add: string }> = {
  'receipt.lines': { item: 'artItemLine', add: 'artAddLine' },
  'apps.items': { item: 'artItemApp', add: 'artAddApp' },
  'apps.items.rows': { item: 'artItemRow', add: 'artAddRow' },
  'versus.before.items': { item: 'artItemBefore', add: 'artAddBefore' },
  'versus.after.items': { item: 'artItemAfter', add: 'artAddAfter' },
  'fanout.outputs': { item: 'artItemOutput', add: 'artAddOutput' },
  'phone.notes': { item: 'artItemNote', add: 'artAddNote' },
  'wall.spaces': { item: 'artItemSpace', add: 'artAddSpace' },
  'wall.spaces.docs': { item: 'artItemDoc', add: 'artAddDoc' },
  'tally.items': { item: 'artItemCard', add: 'artAddCard' },
  'log.lines': { item: 'artItemLine', add: 'artAddLine' },
};

/** An enum value's label, by value (shared across visuals). */
const ENUM_LABELS: Record<string, string> = {
  highlight: 'artEnumHighlight',
  // An accent is a theme-token name; the editor shows it as the colour it reads as.
  info: 'artEnumBlue',
  success: 'artEnumGreen',
  ai: 'artEnumPurple',
  done: 'artEnumDone',
  waiting: 'artEnumWaiting',
  partial: 'artEnumPartial',
  none: 'artEnumNotYet',
};

/** The hint shown until a visual has enough to draw. */
export const ART_NEEDS_HINT: Record<HeroArtVisual, string> = {
  receipt: 'artNeedsReceipt',
  apps: 'artNeedsApps',
  versus: 'artNeedsVersus',
  fanout: 'artNeedsFanout',
  phone: 'artNeedsPhone',
  wall: 'artNeedsWall',
  tally: 'artNeedsTally',
  log: 'artNeedsLog',
};

const isPresentation = (f: ArtField): boolean => f.kind === 'enum' || f.kind === 'fraction' || f.kind === 'count';

interface ShapeProps {
  shape: ArtShape;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  showState: boolean;
  path: string;
  /** The item this shape belongs to ("Line 2"), named in each field's accessible name. */
  item?: string | undefined;
}

function ShapeFields({ shape, value, onChange, showState, path, item }: ShapeProps): JSX.Element {
  const { t } = useTranslation('cms');
  const set = (key: string, v: unknown): void => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <>
      {Object.entries(shape).map(([key, f]) => {
        if (isPresentation(f) && !showState) return null;
        // Only a visual's own `label` is its spoken caption; a nested one is shown text.
        const nested = path.includes('.');
        const label = t(key === 'label' && nested ? 'artFieldLabel' : FIELD_LABELS[key] ?? key);
        const aria = item ? t('artItemFieldAria', { item, field: label }) : label;
        if (f.kind === 'text') {
          return (
            <label key={key} className="u-grid u-gap-1">
              <span className="u-label-sm">{label}</span>
              <input aria-label={aria} maxLength={f.max} value={str(value[key])} onChange={(e) => set(key, e.target.value)} />
            </label>
          );
        }
        if (f.kind === 'enum') {
          return (
            <label key={key} className="u-grid u-gap-1">
              <span className="u-label-sm">{label}</span>
              <select aria-label={aria} value={str(value[key])} onChange={(e) => set(key, e.target.value || undefined)}>
                <option value="">{t('artEnumNone')}</option>
                {f.values.map((v) => <option key={v} value={v}>{t(ENUM_LABELS[v] ?? v)}</option>)}
              </select>
            </label>
          );
        }
        if (f.kind === 'fraction' || f.kind === 'count') {
          // A fraction is edited as a whole percentage; a count as a whole number.
          const max = f.kind === 'fraction' ? 100 : f.max;
          const raw = value[key];
          const shown = typeof raw === 'number' ? (f.kind === 'fraction' ? Math.round(raw * 100) : raw) : '';
          return (
            <label key={key} className="u-grid u-gap-1">
              <span className="u-label-sm">{label}</span>
              <input
                type="number" min={0} max={max} step={1} aria-label={aria} value={shown}
                onChange={(e) => {
                  const n = e.target.value === '' ? undefined : Math.min(max, Math.max(0, Math.round(Number(e.target.value))));
                  set(key, n === undefined || Number.isNaN(n) ? undefined : f.kind === 'fraction' ? n / 100 : n);
                }}
              />
            </label>
          );
        }
        if (f.kind === 'object') {
          return (
            <fieldset key={key} className="surface-card u-grid u-gap-1 u-p-2 u-m-0">
              <legend className="u-label-sm">{label}</legend>
              <ShapeFields shape={f.shape} value={obj(value[key])} onChange={(v) => set(key, Object.keys(v).length > 0 ? v : undefined)} showState={showState} path={`${path}.${key}`} item={item} />
            </fieldset>
          );
        }
        return <ListFields key={key} field={f} value={value[key]} onChange={(v) => set(key, v)} showState={showState} path={`${path}.${key}`} />;
      })}
    </>
  );
}

function ListFields({ field, value, onChange, showState, path }: { field: Extract<ArtField, { kind: 'list' }>; value: unknown; onChange: (v: unknown[] | undefined) => void; showState: boolean; path: string }): JSX.Element {
  const { t } = useTranslation('cms');
  const rows = (Array.isArray(value) ? value : []).map(obj);
  const names = LIST_LABELS[path] ?? { item: 'artItemGeneric', add: 'artAddGeneric' };
  const setRows = (next: Record<string, unknown>[]): void => onChange(next.length > 0 ? next : undefined);
  return (
    <div className="u-grid u-gap-1">
      {rows.map((r, i) => {
        const item = t(names.item, { n: formatNumber(i + 1) });
        return (
          <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
            <span className="u-label-sm">{item}</span>
            <ShapeFields shape={field.item} value={r} onChange={(v) => setRows(rows.map((x, j) => (j === i ? v : x)))} showState={showState} path={path} item={item} />
            <Button variant="quiet" className="u-w-auto" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t('artRemoveItemAria', { item })}><TrashIcon /> {t('removeItem')}</Button>
          </div>
        );
      })}
      {rows.length < field.cap
        ? <Button variant="quiet" className="u-w-auto" onClick={() => setRows([...rows, {}])}><PlusIcon /> {t(names.add)}</Button>
        : <p className="u-label-sm muted u-m-0">{t('artListFullHint', { max: formatNumber(field.cap) })}</p>}
    </div>
  );
}

/** ADR 1060 — one illustrated visual's fields. */
export function HeroArtFields({ visual, value, onChange, showState }: { visual: HeroArtVisual; value: unknown; onChange: (v: Record<string, unknown>) => void; showState: boolean }): JSX.Element {
  const { t } = useTranslation('cms');
  return (
    <fieldset className="u-grid u-gap-2 u-border-0 u-p-0 u-m-0">
      <legend className="u-label-sm">{t('artEditorLegend')}</legend>
      <p className="u-label-sm muted u-m-0">{t(ART_NEEDS_HINT[visual])}</p>
      <ShapeFields shape={HERO_ART_SPECS[visual]} value={obj(value)} onChange={onChange} showState={showState} path={visual} />
    </fieldset>
  );
}
