/**
 * The OpenWOP profile of A2UI v0.9 — the closed allowlist a version-2
 * `ui.a2ui-surface` may use (RFC 0209 §B, ADR 0749).
 *
 * This is the render-side security spine for the v0.9 path, exactly as
 * `../catalog.ts` is for the 0.9.1 tree: a surface is DATA the renderer walks,
 * never code, and anything this table does not model is refused fail-closed.
 * The profile removes from upstream A2UI and never adds: no `functionCall`
 * actions (so no `openUrl`), no URL-bearing media (`Image`/`Video`/
 * `AudioPlayer`), no `theme.iconUrl`, no `obscured` (secret) text field, no
 * `FunctionCall` values except a `required` check.
 *
 * The table MIRRORS `schemas/v2/envelopes/ui.a2ui-surface.schema.json` `$defs`
 * and `__tests__/a2ui-v09-profile-parity.test.ts` pins it to that file — every
 * component, every property, every enum — so the two cannot drift silently.
 */

import i18n from '../../../i18n/index.js';

export const A2UI_V09_VERSION = 'v0.9';
export const A2UI_V09_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
export const A2UI_V09_CATALOG_IDS: readonly string[] = [A2UI_V09_CATALOG_ID];

export type Binding = { path: string };
export type DynString = string | Binding;
export type DynBool = boolean | Binding;
export type DynValue = string | number | boolean | unknown[] | Binding;

export interface RequiredCheck { condition: { call: 'required'; args: { value: Binding }; returnType?: 'boolean' }; message: string }
interface Base { id: string; accessibility?: { label?: DynString; description?: DynString }; weight?: number }

export type V09Component =
  | (Base & { component: 'Text'; text: DynString; variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body' })
  | (Base & { component: 'TextField'; label: DynString; value?: DynString; variant?: 'longText' | 'number' | 'shortText'; validationRegexp?: string; checks?: RequiredCheck[] })
  | (Base & { component: 'CheckBox'; label: DynString; value: DynBool; checks?: RequiredCheck[] })
  | (Base & { component: 'ChoicePicker'; label?: DynString; options: Array<{ label: DynString; value: string }>; value: string[] | Binding; variant?: 'multipleSelection' | 'mutuallyExclusive'; displayStyle?: 'checkbox' | 'chips'; filterable?: boolean; checks?: RequiredCheck[] })
  | (Base & { component: 'DateTimeInput'; label?: DynString; value: DynString; enableDate?: boolean; enableTime?: boolean; checks?: RequiredCheck[] })
  | (Base & { component: 'Button'; child: string; variant?: 'default' | 'primary' | 'borderless'; action: { event: { name: 'resume' | 'exchange'; context?: Record<string, DynValue> } } })
  | (Base & { component: 'Column'; children: string[]; justify?: string; align?: string })
  | (Base & { component: 'Row'; children: string[]; justify?: string; align?: string })
  | (Base & { component: 'Card'; child: string })
  | (Base & { component: 'Divider'; axis?: 'horizontal' | 'vertical' });

export type V09ComponentType = V09Component['component'];

export type V09Message =
  | { version: 'v0.9'; createSurface: { surfaceId: string; catalogId: string; theme?: { primaryColor?: string; agentDisplayName?: string } } }
  | { version: 'v0.9'; updateComponents: { surfaceId: string; components: V09Component[] } }
  | { version: 'v0.9'; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
  | { version: 'v0.9'; deleteSurface: { surfaceId: string } };

/** One version-2 `ui.a2ui-surface` payload. */
export interface V09Payload {
  version: 'v0.9';
  catalogId: string;
  surfaceId: string;
  reasoning?: string;
  messages: V09Message[];
}

// ── the table ──────────────────────────────────────────────────────────────
type Check = (v: unknown) => boolean;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (max: number): Check => (v) => typeof v === 'string' && v.length <= max;
const oneOf = (...values: readonly string[]): Check => (v) => typeof v === 'string' && values.includes(v);
const bool: Check = (v) => typeof v === 'boolean';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const COMPONENT_ID = /^[A-Za-z0-9_.-]+$/;
const componentId: Check = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 128 && COMPONENT_ID.test(v);
const binding: Check = (v) => isRecord(v) && Object.keys(v).length === 1 && typeof v.path === 'string' && v.path.startsWith('/') && v.path.length <= 512;
const dynString: Check = (v) => str(4096)(v) || binding(v);
const dynBool: Check = (v) => bool(v) || binding(v);
const dynStringList: Check = (v) => (Array.isArray(v) && v.length <= 256 && v.every(str(1024))) || binding(v);
const dynValue: Check = (v) => str(4096)(v) || num(v) || bool(v) || (Array.isArray(v) && v.length <= 256) || binding(v);
const closed = (shape: Record<string, Check>, required: readonly string[]): Check => (v) =>
  isRecord(v) && required.every((k) => k in v) && Object.entries(v).every(([k, x]) => shape[k]?.(x) === true);
const accessibility = closed({ label: dynString, description: dynString }, []);
const check: Check = closed({
  message: str(512),
  condition: closed({ call: oneOf('required'), args: closed({ value: binding }, ['value']), returnType: oneOf('boolean') }, ['call', 'args']),
}, ['condition', 'message']);
const checks: Check = (v) => Array.isArray(v) && v.length <= 16 && v.every(check);
const childIds: Check = (v) => Array.isArray(v) && v.length <= 256 && v.every(componentId);
const option = closed({ label: dynString, value: str(1024) }, ['label', 'value']);
const action = closed({
  event: closed({
    name: oneOf('resume', 'exchange'),
    context: (v) => isRecord(v) && Object.keys(v).length <= 64 && Object.values(v).every(dynValue),
  }, ['name']),
}, ['event']);

/** Per component: every property the schema admits, with its checker, and the
 *  required set. Exported for the parity test. */
export const PROFILE: Readonly<Record<V09ComponentType, { props: Record<string, Check>; required: readonly string[]; enums: Record<string, readonly string[]> }>> = (() => {
  const base = { id: componentId, component: () => true, accessibility, weight: num };
  const e = {
    textVariant: ['h1', 'h2', 'h3', 'h4', 'h5', 'caption', 'body'],
    fieldVariant: ['longText', 'number', 'shortText'],
    choiceVariant: ['multipleSelection', 'mutuallyExclusive'],
    displayStyle: ['checkbox', 'chips'],
    buttonVariant: ['default', 'primary', 'borderless'],
    justify: ['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'],
    align: ['start', 'center', 'end', 'stretch'],
    axis: ['horizontal', 'vertical'],
  } as const;
  return {
    Text: { props: { ...base, text: dynString, variant: oneOf(...e.textVariant) }, required: ['id', 'component', 'text'], enums: { variant: e.textVariant } },
    TextField: { props: { ...base, checks, label: dynString, value: dynString, variant: oneOf(...e.fieldVariant), validationRegexp: str(256) }, required: ['id', 'component', 'label'], enums: { variant: e.fieldVariant } },
    CheckBox: { props: { ...base, checks, label: dynString, value: dynBool }, required: ['id', 'component', 'label', 'value'], enums: {} },
    ChoicePicker: { props: { ...base, checks, label: dynString, variant: oneOf(...e.choiceVariant), options: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 256 && v.every(option), value: dynStringList, displayStyle: oneOf(...e.displayStyle), filterable: bool }, required: ['id', 'component', 'options', 'value'], enums: { variant: e.choiceVariant, displayStyle: e.displayStyle } },
    DateTimeInput: { props: { ...base, checks, label: dynString, value: dynString, enableDate: bool, enableTime: bool }, required: ['id', 'component', 'value'], enums: {} },
    Button: { props: { ...base, child: componentId, variant: oneOf(...e.buttonVariant), action }, required: ['id', 'component', 'child', 'action'], enums: { variant: e.buttonVariant } },
    Column: { props: { ...base, children: childIds, justify: oneOf(...e.justify), align: oneOf(...e.align) }, required: ['id', 'component', 'children'], enums: { justify: e.justify, align: e.align } },
    Row: { props: { ...base, children: childIds, justify: oneOf(...e.justify), align: oneOf(...e.align) }, required: ['id', 'component', 'children'], enums: { justify: e.justify, align: e.align } },
    Card: { props: { ...base, child: componentId }, required: ['id', 'component', 'child'], enums: {} },
    Divider: { props: { ...base, axis: oneOf(...e.axis) }, required: ['id', 'component'], enums: { axis: e.axis } },
  };
})();

export const PROFILE_COMPONENTS = Object.keys(PROFILE) as V09ComponentType[];

const SURFACE_ID = /^[A-Za-z0-9_.:-]+$/;
const surfaceId: Check = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 128 && SURFACE_ID.test(v);
const catalogId: Check = (v) => typeof v === 'string' && A2UI_V09_CATALOG_IDS.includes(v);
const version: Check = (v) => v === A2UI_V09_VERSION;

/** Why a component is refused, or null. */
function rejectComponent(raw: unknown): string | null {
  if (!isRecord(raw) || typeof raw.component !== 'string') return i18n.t('chat:a2uiRejectMissingDiscriminator');
  const spec = (PROFILE as Record<string, (typeof PROFILE)[V09ComponentType] | undefined>)[raw.component];
  if (!spec) return i18n.t('chat:a2uiV09RejectComponent', { component: raw.component });
  if (!closed(spec.props, spec.required)(raw)) return i18n.t('chat:a2uiV09RejectComponentShape', { component: raw.component, id: typeof raw.id === 'string' ? raw.id : '?' });
  return null;
}

const MESSAGE_SHAPES: Record<string, Check> = {
  createSurface: closed({ surfaceId, catalogId, theme: closed({ primaryColor: (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v), agentDisplayName: str(128) }, []) }, ['surfaceId', 'catalogId']),
  updateDataModel: closed({ surfaceId, path: (v) => typeof v === 'string' && v.startsWith('/') && v.length <= 512, value: () => true }, ['surfaceId']),
  deleteSurface: closed({ surfaceId }, ['surfaceId']),
};

/** Why a message is refused, or null. */
function rejectMessage(raw: unknown, index: number, payloadSurfaceId: string): string | null {
  const bad = i18n.t('chat:a2uiV09RejectMessage', { index });
  if (!isRecord(raw) || !version(raw.version)) return bad;
  const keys = Object.keys(raw).filter((k) => k !== 'version');
  if (keys.length !== 1) return bad;
  const kind = keys[0]!;
  const body = raw[kind];
  if (!isRecord(body) || body.surfaceId !== payloadSurfaceId) return bad;
  if (kind === 'updateComponents') {
    if (!closed({ surfaceId, components: () => true }, ['surfaceId', 'components'])(body)) return bad;
    const list = body.components;
    if (!Array.isArray(list) || list.length < 1 || list.length > 512) return bad;
    for (const c of list) {
      const r = rejectComponent(c);
      if (r) return r;
    }
    return null;
  }
  const shape = MESSAGE_SHAPES[kind];
  return shape && shape(body) ? null : bad;
}

export type V09Parse = { ok: true; payload: V09Payload } | { ok: false; reason: string };

/** Is this payload a version-2 (A2UI v0.9) body at all? Branch selection is by
 *  shape here because the card payload carries no `schemaVersion`; the two
 *  branches are disjoint (`version: "v0.9"` vs `catalogVersion`). */
export function isV09Payload(payload: unknown): boolean {
  return isRecord(payload) && payload.version === A2UI_V09_VERSION;
}

/** Validate one version-2 payload against the profile. Fail-closed. */
export function parseV09Payload(payload: unknown): V09Parse {
  if (!isRecord(payload)) return { ok: false, reason: i18n.t('chat:a2uiRejectPayloadNotObject') };
  const allowed = new Set(['reasoning', 'version', 'catalogId', 'surfaceId', 'messages']);
  if (Object.keys(payload).some((k) => !allowed.has(k)) || !version(payload.version)) return { ok: false, reason: i18n.t('chat:a2uiRejectPayloadNotObject') };
  if (!catalogId(payload.catalogId)) return { ok: false, reason: i18n.t('chat:a2uiV09RejectCatalog') };
  if (!surfaceId(payload.surfaceId)) return { ok: false, reason: i18n.t('chat:a2uiRejectPayloadNotObject') };
  if (payload.reasoning !== undefined && typeof payload.reasoning !== 'string') return { ok: false, reason: i18n.t('chat:a2uiRejectPayloadNotObject') };
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 64) return { ok: false, reason: i18n.t('chat:a2uiRejectPayloadNotObject') };
  for (const [i, m] of messages.entries()) {
    const r = rejectMessage(m, i, payload.surfaceId as string);
    if (r) return { ok: false, reason: r };
    const create = (m as Record<string, unknown>).createSurface;
    if (isRecord(create) && create.catalogId !== payload.catalogId) return { ok: false, reason: i18n.t('chat:a2uiV09RejectCatalog') };
  }
  return { ok: true, payload: payload as unknown as V09Payload };
}
