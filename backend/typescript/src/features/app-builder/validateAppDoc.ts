/**
 * Document-level validation for `canvas.app-builder` (ADR 0305 Phase C, architect
 * amendment 1; ADR 0343 comprehensive-document facets). The host catalog validates
 * NODES closed-world (`validateComponentTree`); cross-facet references — a
 * `navigateTo`/connector pointing at a missing screen, a `list.bind` pointing at a
 * missing dataSource, an action invoking a missing operation — are only visible at
 * the document level, and they are legitimate MID-EDIT states (the button often
 * exists before its target screen). So structural catalog violations stay HARD
 * errors; cross-references are SOFT warnings the editor surfaces without blocking
 * save. The editor PATCH path runs ONLY this validator (not the artifact JSON
 * Schema), so EVERY schema constraint is mirrored hard here — the two gates agree.
 */
import { validateComponentTree, getCanvasComponent, type ComponentTreeError } from '../../host/canvasComponentCatalog.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';

interface Node { type?: unknown; props?: Record<string, unknown>; children?: unknown; actions?: unknown; bindings?: unknown }
interface ScreenIn { id?: unknown; components?: unknown; x?: unknown; y?: unknown }
interface ConnectorIn {
  from?: unknown; to?: unknown; trigger?: unknown; label?: unknown;
  sourceEdge?: unknown; targetEdge?: unknown; transition?: unknown; routingStyle?: unknown; animated?: unknown;
}
interface DocIn {
  name?: unknown; theme?: unknown; themeColors?: unknown;
  schemaVersion?: unknown; designSystemRef?: unknown; brandRef?: unknown;
  screens?: ScreenIn[];
  connectors?: ConnectorIn[];
  dataSources?: { id?: unknown; rows?: unknown }[];
  stateVariables?: unknown; models?: unknown; operations?: unknown;
  authProfile?: unknown; envRequirements?: unknown; componentDefinitions?: unknown;
  sharePolicy?: unknown;
}

export interface AppDocValidation {
  /** Hard catalog/structure violations — reject the write. */
  errors: ComponentTreeError[];
  /** Soft cross-reference issues — surface, never block. */
  warnings: { path: string; message: string }[];
}

// Grade pass 2026-07-07 (F3 + DATA-7): structural caps enforced HARD on the save
// path (the JSON Schema documents them but the PATCH never ran it — a deep body
// could RangeError the recursive validators/renderers into a 500), and id
// hygiene: screen/dataSource ids are slugs (they are interpolated into GENERATED
// SOURCE — see generators.ts jsId) and duplicates are never a legitimate
// mid-edit state (navigation would be ambiguous).
export const MAX_SCREENS = 60;
const MAX_CHILDREN_PER_LEVEL = 200;
const MAX_DEPTH = 20;
const MAX_TOTAL_NODES = 2000;
// Grade code-F8: require ≥1 alphanumeric — ids like '.'/'..' matched before
// and collapsed to colliding paths in the Next.js export ('app/../page.jsx').
const ID_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]{1,80}$/;

// ADR 0323 — screen-flow graph closed-world enums + position bound. The editor
// PATCH path runs ONLY this validator (not the artifact JSON Schema), so the
// graph fields are enforced HARD here, mirroring the id-slug enforcement above.
// Positions are bounded finite so a hostile/huge coordinate can't wreck the SVG
// surface (the class of bug MyndHyve's NaN-guard covered).
const POS_BOUND = 100_000;
const EDGES = new Set(['top', 'right', 'bottom', 'left']);
// Exported so catalogParity can pin the prompt's connector vocabulary
// (XCH-APPB-1, LLM-EXCHANGE-AUDIT Wave 3).
export const CONNECTOR_TRANSITIONS = ['push', 'replace', 'modal', 'fade', 'slide', 'none'] as const;
export const CONNECTOR_TRIGGERS = ['click', 'submit', 'load'] as const;
const TRANSITIONS = new Set<string>(CONNECTOR_TRANSITIONS);
const TRIGGERS = new Set<string>(CONNECTOR_TRIGGERS);
const MAX_CONNECTORS = 200;   // = the artifact schema's maxItems
const MAX_LABEL = 120;        // = the artifact schema's maxLength
const MAX_SAMPLE_ROWS = 10;   // = the artifact schema's rows maxItems
const ROUTING = new Set(['bezier', 'orthogonal', 'straight', 'step']);
const inBounds = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= POS_BOUND;

// ── ADR 0343 facet vocabulary (each mirrors the artifact schema EXACTLY) ──────
// `\w`-safe names: they become binding-path segments + generated identifiers
// (the RFC 0124 lesson — a hyphen silently breaks {{var}} substitution).
const WORD_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const BINDING_PATH_RE = /^(state|model|op|source)\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;
const STATE_TYPES = new Set(['string', 'number', 'boolean', 'list']);
const MODEL_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'date', 'reference']);
const OP_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'object', 'list']);
const OP_KINDS = new Set(['list', 'get', 'create', 'update', 'delete', 'action']);
const OP_OUTPUT_TYPES = new Set(['model', 'modelList', 'object', 'none']);
const OP_AUTH = new Set(['none', 'user', 'role']);
const AUTH_KINDS = new Set(['none', 'email-password', 'oauth', 'sso']);
const ACTION_EVENTS = new Set(['click', 'submit', 'load', 'change']);
const ACTION_KINDS = new Set(['navigate', 'set-state', 'submit-form', 'invoke-operation', 'open-modal', 'close-modal']);
const BINDING_FORMATS = new Set(['text', 'number', 'currency', 'date']);
const BINDING_MODES = new Set(['one-way', 'two-way']);
const REF_MODES = new Set(['linked', 'detached']);
const ENV_STAGES = new Set(['runtime', 'build', 'deploy']);
const MAX_STATE_VARS = 50;
const MAX_MODELS = 30;
const MAX_MODEL_FIELDS = 40;
const MAX_RELATIONSHIPS = 20;
const MAX_OPERATIONS = 50;
const MAX_OP_FIELDS = 20;
const MAX_OP_ERRORS = 10;
const MAX_ROLES = 10;
const MAX_GUARDS = 60;
const MAX_ENV_REQS = 30;
const MAX_COMPONENT_DEFS = 30;
const MAX_ACTIONS_PER_NODE = 5;
const MAX_BINDINGS_PER_NODE = 10;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max);

/** The document ids the soft cross-reference pass resolves against. */
interface RefSets {
  screens: Set<string>; sources: Set<string>; stateVars: Set<string>;
  models: Set<string>; operations: Set<string>; roles: Set<string>; componentDefs: Set<string>;
}

export function validateAppDoc(doc: unknown): AppDocValidation {
  const d = (doc ?? {}) as DocIn;
  const errors: ComponentTreeError[] = [];
  const warnings: AppDocValidation['warnings'] = [];
  const screens = Array.isArray(d.screens) ? d.screens : [];
  const screenIds = new Set(screens.map((s) => (typeof s.id === 'string' ? s.id : '')).filter(Boolean));
  const sourceIds = new Set((Array.isArray(d.dataSources) ? d.dataSources : []).map((s) => (typeof s.id === 'string' ? s.id : '')).filter(Boolean));

  // Grade D-F5 (doc-level parity with the artifact schema): name bound, theme
  // enum, themeColors hex — a raw PATCH must not persist what emit would reject.
  if (d.name !== undefined && (typeof d.name !== 'string' || d.name.length > 200)) {
    errors.push({ path: 'name', code: 'bad_prop_value', message: 'name must be a string of at most 200 characters' });
  }
  if (d.theme !== undefined && !(d.theme === 'default' || d.theme === 'light' || d.theme === 'dark')) {
    errors.push({ path: 'theme', code: 'bad_prop_value', message: 'theme must be one of: default, light, dark' });
  }
  if (d.themeColors !== undefined) {
    const tc = (d.themeColors ?? {}) as Record<string, unknown>;
    for (const k of ['primary', 'secondary'] as const) {
      if (tc[k] !== undefined && !(typeof tc[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(tc[k] as string))) {
        errors.push({ path: `themeColors.${k}`, code: 'bad_prop_value', message: `${k} must be a 6-digit hex color` });
      }
    }
  }

  if (screens.length > MAX_SCREENS) {
    errors.push({ path: 'screens', code: 'illegal_children', message: `too many screens (${screens.length} > ${MAX_SCREENS})` });
  }
  // Slug + uniqueness for the ids that reach generated source / navigation.
  const seenScreen = new Set<string>();
  screens.forEach((sc, i) => {
    const id = typeof sc.id === 'string' ? sc.id : '';
    if (id && !ID_RE.test(id)) errors.push({ path: `screens[${i}].id`, code: 'bad_prop_value', message: `screen id '${id.slice(0, 40)}' must match ${String(ID_RE)}` });
    if (id && seenScreen.has(id)) errors.push({ path: `screens[${i}].id`, code: 'bad_prop_value', message: `duplicate screen id '${id}'` });
    if (id) seenScreen.add(id);
    // ADR 0323 — node position: optional, but if present must be a bounded finite
    // number (the editor writes snapped coords; the AI may omit them → auto-layout).
    for (const axis of ['x', 'y'] as const) {
      if (sc[axis] !== undefined && !inBounds(sc[axis])) {
        errors.push({ path: `screens[${i}].${axis}`, code: 'bad_prop_value', message: `screen ${axis} must be a finite number within ±${POS_BOUND}` });
      }
    }
  });
  const seenSource = new Set<string>();
  (Array.isArray(d.dataSources) ? d.dataSources : []).forEach((src, i) => {
    if (Array.isArray(src.rows) && src.rows.length > MAX_SAMPLE_ROWS) {
      errors.push({ path: `dataSources[${i}].rows`, code: 'illegal_children', message: `at most ${MAX_SAMPLE_ROWS} sample rows` });
    }
    const id = typeof src.id === 'string' ? src.id : '';
    if (id && !ID_RE.test(id)) errors.push({ path: `dataSources[${i}].id`, code: 'bad_prop_value', message: `data source id '${id.slice(0, 40)}' must match ${String(ID_RE)}` });
    if (id && seenSource.has(id)) errors.push({ path: `dataSources[${i}].id`, code: 'bad_prop_value', message: `duplicate data source id '${id}'` });
    if (id) seenSource.add(id);
  });
  const homes = screens.filter((sc) => (sc as { isInitial?: unknown }).isInitial === true).length;
  if (screens.length > 0 && homes !== 1) {
    warnings.push({ path: 'screens', message: `expected exactly one home screen (isInitial), found ${homes}` });
  }

  // ── ADR 0343 facets — HARD structural mirror of the artifact schema ─────────
  const refs: RefSets = {
    screens: screenIds, sources: sourceIds,
    stateVars: new Set<string>(), models: new Set<string>(), operations: new Set<string>(),
    roles: new Set<string>(), componentDefs: new Set<string>(),
  };
  validateFacets(d, errors, refs);
  crossRefFacets(d, warnings, refs);

  // Depth + node-count caps, enforced BEFORE the recursive catalog walk —
  // componentDefinitions roots count toward the SAME document budget.
  let totalNodes = 0;
  const capCheck = (nodes: unknown, base: string, depth: number): void => {
    if (!Array.isArray(nodes)) return;
    if (nodes.length > MAX_CHILDREN_PER_LEVEL) {
      errors.push({ path: base, code: 'illegal_children', message: `too many components at one level (${nodes.length} > ${MAX_CHILDREN_PER_LEVEL})` });
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      totalNodes += 1;
      if (totalNodes > MAX_TOTAL_NODES) {
        errors.push({ path: `${base}[${i}]`, code: 'illegal_children', message: `document exceeds ${MAX_TOTAL_NODES} components` });
        return;
      }
      if (depth >= MAX_DEPTH) {
        const kids = (nodes[i] as { children?: unknown })?.children;
        if (Array.isArray(kids) && kids.length > 0) {
          errors.push({ path: `${base}[${i}].children`, code: 'illegal_children', message: `component tree deeper than ${MAX_DEPTH}` });
        }
        continue;
      }
      capCheck((nodes[i] as { children?: unknown })?.children, `${base}[${i}].children`, depth + 1);
    }
  };
  screens.forEach((sc, si) => capCheck(sc.components, `screens[${si}].components`, 0));
  const compDefs = Array.isArray(d.componentDefinitions) ? d.componentDefinitions : [];
  compDefs.forEach((def, di) => {
    const root = isObj(def) ? def.root : undefined;
    if (root !== undefined) capCheck([root], `componentDefinitions[${di}].root`, 0);
  });
  if (errors.length) return { errors, warnings };

  // Catalog validation + the per-node action/binding walk, over screens AND
  // componentDefinitions (one code path — definitions are ordinary subtrees).
  const checkTree = (nodes: Node[], base: string): void => {
    errors.push(...validateComponentTree(APP_BUILDER_CANVAS_TYPE, nodes, base));
    walk(nodes, base, (node, path) => {
      const props = node.props ?? {};
      const def = typeof node.type === 'string' ? getCanvasComponent(APP_BUILDER_CANVAS_TYPE, node.type) : undefined;
      for (const pd of def?.props ?? []) {
        if (pd.type === 'screen') {
          const v = props[pd.name];
          if (typeof v === 'string' && v && !refs.screens.has(v)) {
            warnings.push({ path: `${path}.props.${pd.name}`, message: `references missing screen '${v}'` });
          }
        }
      }
      if (node.type === 'list') {
        const bind = props.bind;
        if (typeof bind === 'string' && bind && !refs.sources.has(bind)) {
          warnings.push({ path: `${path}.props.bind`, message: `references missing data source '${bind}'` });
        }
      }
      // ADR 0344 2c — minChildren is advisory (SOFT): a container being
      // assembled legitimately has too few children mid-edit.
      if (def && typeof def.minChildren === 'number') {
        const count = Array.isArray(node.children) ? node.children.length : 0;
        if (count < def.minChildren) {
          warnings.push({ path, message: `'${String(node.type)}' expects at least ${def.minChildren} children (has ${count})` });
        }
      }
      validateNodeActions(node, path, errors, warnings, refs);
      validateNodeBindings(node, path, errors, warnings, refs);
    });
  };
  screens.forEach((s, si) => checkTree(Array.isArray(s.components) ? (s.components as Node[]) : [], `screens[${si}].components`));
  compDefs.forEach((def, di) => {
    const root = isObj(def) ? def.root : undefined;
    if (isObj(root)) checkTree([root as Node], `componentDefinitions[${di}].root`);
  });

  // Grade F5/D-F5: the editor gate must match the artifact schema on EVERY
  // connector constraint (count, required endpoints, trigger, label bound) —
  // not just the presentation enums; a raw PATCH bypasses the JSON Schema.
  const connectors = Array.isArray(d.connectors) ? d.connectors : [];
  if (connectors.length > MAX_CONNECTORS) {
    errors.push({ path: 'connectors', code: 'illegal_children', message: `at most ${MAX_CONNECTORS} connectors` });
  }
  connectors.forEach((c, i) => {
    for (const end of ['from', 'to'] as const) {
      const v = c[end];
      if (typeof v !== 'string' || !v) {
        errors.push({ path: `connectors[${i}].${end}`, code: 'bad_prop_value', message: `${end} must be a screen id` });
      } else if (!screenIds.has(v)) {
        warnings.push({ path: `connectors[${i}].${end}`, message: `references missing screen '${v}'` });
      }
    }
    if (c.trigger !== undefined && (typeof c.trigger !== 'string' || !TRIGGERS.has(c.trigger))) {
      errors.push({ path: `connectors[${i}].trigger`, code: 'bad_prop_value', message: `trigger must be one of: ${[...TRIGGERS].join(', ')}` });
    }
    if (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > MAX_LABEL)) {
      errors.push({ path: `connectors[${i}].label`, code: 'bad_prop_value', message: `label must be a string of at most ${MAX_LABEL} characters` });
    }
    // ADR 0323 — closed-world edge presentation (HARD; the editor path skips the
    // JSON Schema). Membership only; absence is legal (all optional).
    const enumCheck = (field: 'sourceEdge' | 'targetEdge' | 'transition' | 'routingStyle', set: Set<string>): void => {
      const v = c[field];
      if (v !== undefined && (typeof v !== 'string' || !set.has(v))) {
        errors.push({ path: `connectors[${i}].${field}`, code: 'bad_prop_value', message: `${field} must be one of: ${[...set].join(', ')}` });
      }
    };
    enumCheck('sourceEdge', EDGES);
    enumCheck('targetEdge', EDGES);
    enumCheck('transition', TRANSITIONS);
    enumCheck('routingStyle', ROUTING);
    if (c.animated !== undefined && typeof c.animated !== 'boolean') {
      errors.push({ path: `connectors[${i}].animated`, code: 'bad_prop_value', message: 'animated must be a boolean' });
    }
    // A self-edge (from === to) is structurally legal but almost always a mistake.
    if (typeof c.from === 'string' && c.from && c.from === c.to) {
      warnings.push({ path: `connectors[${i}]`, message: `connector loops screen '${c.from}' back to itself` });
    }
  });

  return { errors, warnings };
}

/* ── ADR 0343 — the top-level facet validators (hard mirror + ref collection) ── */

function validateFacets(d: DocIn, errors: ComponentTreeError[], refs: RefSets): void {
  const bad = (path: string, message: string): void => { errors.push({ path, code: 'bad_prop_value', message }); };
  const cap = (path: string, message: string): void => { errors.push({ path, code: 'illegal_children', message }); };

  if (d.schemaVersion !== undefined && !(typeof d.schemaVersion === 'number' && Number.isInteger(d.schemaVersion) && d.schemaVersion >= 1 && d.schemaVersion <= 100)) {
    bad('schemaVersion', 'schemaVersion must be an integer between 1 and 100');
  }
  if (d.sharePolicy !== undefined) {
    const sp = d.sharePolicy;
    if (!isObj(sp)) bad('sharePolicy', 'sharePolicy must be an object');
    else {
      if (sp.sampleData !== undefined && !(sp.sampleData === 'redact' || sp.sampleData === 'include')) {
        bad('sharePolicy.sampleData', "sampleData must be 'redact' or 'include'");
      }
      if (sp.perSource !== undefined) {
        if (!isObj(sp.perSource)) bad('sharePolicy.perSource', 'perSource must be an object of source id → boolean');
        else {
          const entries = Object.entries(sp.perSource);
          if (entries.length > 20) errors.push({ path: 'sharePolicy.perSource', code: 'illegal_children', message: 'at most 20 per-source overrides' });
          for (const [k, v] of entries) {
            if (!ID_RE.test(k)) bad(`sharePolicy.perSource.${k.slice(0, 40)}`, `source id must match ${String(ID_RE)}`);
            else if (typeof v !== 'boolean') bad(`sharePolicy.perSource.${k}`, 'override must be a boolean');
          }
        }
      }
    }
  }
  for (const key of ['designSystemRef', 'brandRef'] as const) {
    const ref = d[key];
    if (ref === undefined) continue;
    if (!isObj(ref) || typeof ref.id !== 'string' || !ref.id || ref.id.length > 120) { bad(key, `${key} must be { id (1-120 chars), mode? }`); continue; }
    if (ref.mode !== undefined && !(typeof ref.mode === 'string' && REF_MODES.has(ref.mode))) bad(`${key}.mode`, `mode must be one of: ${[...REF_MODES].join(', ')}`);
  }

  if (d.stateVariables !== undefined) {
    if (!Array.isArray(d.stateVariables)) { bad('stateVariables', 'stateVariables must be an array'); }
    else {
      if (d.stateVariables.length > MAX_STATE_VARS) cap('stateVariables', `at most ${MAX_STATE_VARS} state variables`);
      const seen = new Set<string>();
      d.stateVariables.forEach((sv, i) => {
        const p = `stateVariables[${i}]`;
        if (!isObj(sv)) { bad(p, 'state variable must be an object'); return; }
        const id = typeof sv.id === 'string' ? sv.id : '';
        if (!WORD_RE.test(id)) bad(`${p}.id`, `state variable id '${String(sv.id).slice(0, 40)}' must match ${String(WORD_RE)} (it becomes a binding segment + generated identifier)`);
        else if (seen.has(id)) bad(`${p}.id`, `duplicate state variable id '${id}'`);
        else { seen.add(id); refs.stateVars.add(id); }
        if (!(typeof sv.type === 'string' && STATE_TYPES.has(sv.type))) bad(`${p}.type`, `type must be one of: ${[...STATE_TYPES].join(', ')}`);
        if (!optStr(sv.label, 120)) bad(`${p}.label`, 'label must be a string of at most 120 characters');
        if (typeof sv.initial === 'string' && sv.initial.length > 400) bad(`${p}.initial`, 'initial string value: at most 400 characters');
        if (Array.isArray(sv.initial) && sv.initial.length > 50) cap(`${p}.initial`, 'initial list value: at most 50 items');
      });
    }
  }

  if (d.models !== undefined) {
    if (!Array.isArray(d.models)) { bad('models', 'models must be an array'); }
    else {
      if (d.models.length > MAX_MODELS) cap('models', `at most ${MAX_MODELS} models`);
      const seen = new Set<string>();
      d.models.forEach((m, i) => {
        const p = `models[${i}]`;
        if (!isObj(m)) { bad(p, 'model must be an object'); return; }
        const id = typeof m.id === 'string' ? m.id : '';
        if (!ID_RE.test(id)) bad(`${p}.id`, `model id '${String(m.id).slice(0, 40)}' must match ${String(ID_RE)}`);
        else if (seen.has(id)) bad(`${p}.id`, `duplicate model id '${id}'`);
        else { seen.add(id); refs.models.add(id); }
        if (!(typeof m.name === 'string' && m.name.length >= 1 && m.name.length <= 120)) bad(`${p}.name`, 'name must be a string of 1-120 characters');
        const fields = m.fields;
        if (!Array.isArray(fields) || fields.length < 1) bad(`${p}.fields`, 'a model needs at least one field');
        else {
          if (fields.length > MAX_MODEL_FIELDS) cap(`${p}.fields`, `at most ${MAX_MODEL_FIELDS} fields`);
          const fseen = new Set<string>();
          fields.forEach((f, fi) => {
            const fp = `${p}.fields[${fi}]`;
            if (!isObj(f)) { bad(fp, 'field must be an object'); return; }
            const fname = typeof f.name === 'string' ? f.name : '';
            if (!WORD_RE.test(fname)) bad(`${fp}.name`, `field name '${String(f.name).slice(0, 40)}' must match ${String(WORD_RE)}`);
            else if (fseen.has(fname)) bad(`${fp}.name`, `duplicate field name '${fname}'`);
            else fseen.add(fname);
            if (!(typeof f.type === 'string' && MODEL_FIELD_TYPES.has(f.type))) bad(`${fp}.type`, `type must be one of: ${[...MODEL_FIELD_TYPES].join(', ')}`);
            if (f.referenceTo !== undefined && f.type !== 'reference') bad(`${fp}.referenceTo`, 'referenceTo is only legal on a reference-typed field');
            if (f.type === 'reference' && !(typeof f.referenceTo === 'string' && f.referenceTo)) bad(`${fp}.referenceTo`, 'a reference field must name its target model (referenceTo)');
            if (f.required !== undefined && typeof f.required !== 'boolean') bad(`${fp}.required`, 'required must be a boolean');
            if (f.validation !== undefined) {
              if (!isObj(f.validation)) bad(`${fp}.validation`, 'validation must be an object');
              else if (!optStr(f.validation.pattern, 200)) bad(`${fp}.validation.pattern`, 'pattern: at most 200 characters');
            }
          });
        }
        if (m.relationships !== undefined) {
          if (!Array.isArray(m.relationships)) bad(`${p}.relationships`, 'relationships must be an array');
          else {
            if (m.relationships.length > MAX_RELATIONSHIPS) cap(`${p}.relationships`, `at most ${MAX_RELATIONSHIPS} relationships`);
            m.relationships.forEach((r, ri) => {
              const rp = `${p}.relationships[${ri}]`;
              if (!isObj(r)) { bad(rp, 'relationship must be an object'); return; }
              if (!(typeof r.to === 'string' && r.to && r.to.length <= 80)) bad(`${rp}.to`, 'to must name a model id');
              if (!(typeof r.kind === 'string' && ['hasOne', 'hasMany', 'belongsTo'].includes(r.kind))) bad(`${rp}.kind`, 'kind must be one of: hasOne, hasMany, belongsTo');
              if (!optStr(r.name, 60)) bad(`${rp}.name`, 'name: at most 60 characters');
            });
          }
        }
      });
    }
  }

  if (d.operations !== undefined) {
    if (!Array.isArray(d.operations)) { bad('operations', 'operations must be an array'); }
    else {
      if (d.operations.length > MAX_OPERATIONS) cap('operations', `at most ${MAX_OPERATIONS} operations`);
      const seen = new Set<string>();
      d.operations.forEach((op, i) => {
        const p = `operations[${i}]`;
        if (!isObj(op)) { bad(p, 'operation must be an object'); return; }
        const id = typeof op.id === 'string' ? op.id : '';
        if (!ID_RE.test(id)) bad(`${p}.id`, `operation id '${String(op.id).slice(0, 40)}' must match ${String(ID_RE)}`);
        else if (seen.has(id)) bad(`${p}.id`, `duplicate operation id '${id}'`);
        else { seen.add(id); refs.operations.add(id); }
        if (!(typeof op.name === 'string' && op.name.length >= 1 && op.name.length <= 120)) bad(`${p}.name`, 'name must be a string of 1-120 characters');
        if (!(typeof op.kind === 'string' && OP_KINDS.has(op.kind))) bad(`${p}.kind`, `kind must be one of: ${[...OP_KINDS].join(', ')}`);
        if (!optStr(op.purpose, 400)) bad(`${p}.purpose`, 'purpose: at most 400 characters');
        if (!optStr(op.modelId, 80)) bad(`${p}.modelId`, 'modelId: at most 80 characters');
        if (!optStr(op.role, 60)) bad(`${p}.role`, 'role: at most 60 characters');
        if (op.auth !== undefined && !(typeof op.auth === 'string' && OP_AUTH.has(op.auth))) bad(`${p}.auth`, `auth must be one of: ${[...OP_AUTH].join(', ')}`);
        // A symbolic adapter id, NEVER a URL or credential-shaped value.
        if (op.adapterRef !== undefined) {
          const a = op.adapterRef;
          if (!(typeof a === 'string' && a.length >= 1 && a.length <= 120)) bad(`${p}.adapterRef`, 'adapterRef must be a string of 1-120 characters');
          else if (/[:/\s]/.test(a)) bad(`${p}.adapterRef`, 'adapterRef must be an installed adapter id — never a URL or path');
        }
        const fieldList = (v: unknown, fp: string): void => {
          if (v === undefined) return;
          if (!Array.isArray(v)) { bad(fp, 'must be an array of typed fields'); return; }
          if (v.length > MAX_OP_FIELDS) cap(fp, `at most ${MAX_OP_FIELDS} fields`);
          v.forEach((f, fi) => {
            if (!isObj(f)) { bad(`${fp}[${fi}]`, 'field must be an object'); return; }
            if (!(typeof f.name === 'string' && WORD_RE.test(f.name))) bad(`${fp}[${fi}].name`, `field name must match ${String(WORD_RE)}`);
            if (!(typeof f.type === 'string' && OP_FIELD_TYPES.has(f.type))) bad(`${fp}[${fi}].type`, `type must be one of: ${[...OP_FIELD_TYPES].join(', ')}`);
          });
        };
        fieldList(op.input, `${p}.input`);
        if (op.output !== undefined) {
          if (!isObj(op.output)) bad(`${p}.output`, 'output must be an object');
          else {
            if (!(typeof op.output.type === 'string' && OP_OUTPUT_TYPES.has(op.output.type))) bad(`${p}.output.type`, `output.type must be one of: ${[...OP_OUTPUT_TYPES].join(', ')}`);
            fieldList(op.output.fields, `${p}.output.fields`);
          }
        }
        if (op.mock !== undefined) {
          if (!isObj(op.mock)) bad(`${p}.mock`, 'mock must be an object');
          else {
            if (!(op.mock.status === 'ok' || op.mock.status === 'error')) bad(`${p}.mock.status`, "mock.status must be 'ok' or 'error'");
            if (op.mock.rows !== undefined && !(Array.isArray(op.mock.rows) && op.mock.rows.length <= MAX_SAMPLE_ROWS)) cap(`${p}.mock.rows`, `at most ${MAX_SAMPLE_ROWS} mock rows`);
            if (!optStr(op.mock.message, 200)) bad(`${p}.mock.message`, 'mock.message: at most 200 characters');
          }
        }
        if (op.errors !== undefined) {
          if (!Array.isArray(op.errors)) bad(`${p}.errors`, 'errors must be an array');
          else {
            if (op.errors.length > MAX_OP_ERRORS) cap(`${p}.errors`, `at most ${MAX_OP_ERRORS} error shapes`);
            op.errors.forEach((e, ei) => {
              if (!isObj(e) || !(typeof e.code === 'string' && WORD_RE.test(e.code))) bad(`${p}.errors[${ei}].code`, `error code must match ${String(WORD_RE)}`);
              else if (!optStr(e.message, 200)) bad(`${p}.errors[${ei}].message`, 'message: at most 200 characters');
            });
          }
        }
      });
    }
  }

  if (d.authProfile !== undefined) {
    const a = d.authProfile;
    if (!isObj(a)) bad('authProfile', 'authProfile must be an object');
    else {
      if (a.kind !== undefined && !(typeof a.kind === 'string' && AUTH_KINDS.has(a.kind))) bad('authProfile.kind', `kind must be one of: ${[...AUTH_KINDS].join(', ')}`);
      if (a.roles !== undefined) {
        if (!Array.isArray(a.roles)) bad('authProfile.roles', 'roles must be an array');
        else {
          if (a.roles.length > MAX_ROLES) cap('authProfile.roles', `at most ${MAX_ROLES} roles`);
          const rseen = new Set<string>();
          a.roles.forEach((r, ri) => {
            if (!(typeof r === 'string' && ROLE_RE.test(r))) bad(`authProfile.roles[${ri}]`, `role must match ${String(ROLE_RE)}`);
            else if (rseen.has(r)) bad(`authProfile.roles[${ri}]`, `duplicate role '${r}'`);
            else { rseen.add(r); refs.roles.add(r); }
          });
        }
      }
      if (a.guards !== undefined) {
        if (!Array.isArray(a.guards)) bad('authProfile.guards', 'guards must be an array');
        else {
          if (a.guards.length > MAX_GUARDS) cap('authProfile.guards', `at most ${MAX_GUARDS} guards`);
          a.guards.forEach((g, gi) => {
            const gp = `authProfile.guards[${gi}]`;
            if (!isObj(g) || !(typeof g.screenId === 'string' && g.screenId && g.screenId.length <= 80)) { bad(gp, 'guard must be { screenId, requiresRole?, redirectTo? }'); return; }
            if (!optStr(g.requiresRole, 40)) bad(`${gp}.requiresRole`, 'requiresRole: at most 40 characters');
            if (!optStr(g.redirectTo, 80)) bad(`${gp}.redirectTo`, 'redirectTo: at most 80 characters');
          });
        }
      }
    }
  }

  if (d.envRequirements !== undefined) {
    if (!Array.isArray(d.envRequirements)) bad('envRequirements', 'envRequirements must be an array');
    else {
      if (d.envRequirements.length > MAX_ENV_REQS) cap('envRequirements', `at most ${MAX_ENV_REQS} environment requirements`);
      const seen = new Set<string>();
      d.envRequirements.forEach((e, i) => {
        const p = `envRequirements[${i}]`;
        if (!isObj(e)) { bad(p, 'environment requirement must be an object'); return; }
        const key = typeof e.key === 'string' ? e.key : '';
        if (!ENV_KEY_RE.test(key)) bad(`${p}.key`, `key '${String(e.key).slice(0, 40)}' must match ${String(ENV_KEY_RE)}`);
        else if (seen.has(key)) bad(`${p}.key`, `duplicate env key '${key}'`);
        else seen.add(key);
        if (!(typeof e.purpose === 'string' && e.purpose.length >= 1 && e.purpose.length <= 200)) bad(`${p}.purpose`, 'purpose must be a string of 1-200 characters');
        if (e.requiredFor !== undefined && !(Array.isArray(e.requiredFor) && e.requiredFor.length <= 3 && e.requiredFor.every((s) => typeof s === 'string' && ENV_STAGES.has(s)))) {
          bad(`${p}.requiredFor`, `requiredFor must list stages from: ${[...ENV_STAGES].join(', ')}`);
        }
      });
    }
  }

  if (d.componentDefinitions !== undefined) {
    if (!Array.isArray(d.componentDefinitions)) bad('componentDefinitions', 'componentDefinitions must be an array');
    else {
      if (d.componentDefinitions.length > MAX_COMPONENT_DEFS) cap('componentDefinitions', `at most ${MAX_COMPONENT_DEFS} component definitions`);
      const seen = new Set<string>();
      d.componentDefinitions.forEach((c, i) => {
        const p = `componentDefinitions[${i}]`;
        if (!isObj(c)) { bad(p, 'component definition must be an object'); return; }
        const id = typeof c.id === 'string' ? c.id : '';
        if (!ID_RE.test(id)) bad(`${p}.id`, `component definition id '${String(c.id).slice(0, 40)}' must match ${String(ID_RE)}`);
        else if (seen.has(id)) bad(`${p}.id`, `duplicate component definition id '${id}'`);
        else { seen.add(id); refs.componentDefs.add(id); }
        if (!(typeof c.name === 'string' && c.name.length >= 1 && c.name.length <= 120)) bad(`${p}.name`, 'name must be a string of 1-120 characters');
        if (!isObj(c.root)) bad(`${p}.root`, 'root must be a component node');
      });
    }
  }

}

/** SOFT cross-facet references — resolved AFTER every facet has registered its
 *  ids (a model may reference a model defined later in the array). Targets may
 *  not exist yet mid-edit: warnings, never blocks. */
function crossRefFacets(d: DocIn, warnings: AppDocValidation['warnings'], refs: RefSets): void {
  const warn = (path: string, message: string): void => { warnings.push({ path, message }); };
  (Array.isArray(d.models) ? d.models : []).forEach((m, i) => {
    if (!isObj(m)) return;
    (Array.isArray(m.fields) ? m.fields : []).forEach((f, fi) => {
      if (isObj(f) && typeof f.referenceTo === 'string' && f.referenceTo && !refs.models.has(f.referenceTo)) {
        warn(`models[${i}].fields[${fi}].referenceTo`, `references missing model '${f.referenceTo}'`);
      }
    });
    (Array.isArray(m.relationships) ? m.relationships : []).forEach((r, ri) => {
      if (isObj(r) && typeof r.to === 'string' && r.to && !refs.models.has(r.to)) {
        warn(`models[${i}].relationships[${ri}].to`, `references missing model '${r.to}'`);
      }
    });
  });
  (Array.isArray(d.operations) ? d.operations : []).forEach((op, i) => {
    if (isObj(op) && typeof op.modelId === 'string' && op.modelId && !refs.models.has(op.modelId)) {
      warn(`operations[${i}].modelId`, `references missing model '${op.modelId}'`);
    }
    if (isObj(op) && op.auth === 'role' && typeof op.role === 'string' && op.role && refs.roles.size && !refs.roles.has(op.role)) {
      warn(`operations[${i}].role`, `references undeclared role '${op.role}'`);
    }
  });
  const sp = isObj(d.sharePolicy) ? d.sharePolicy : undefined;
  if (sp && isObj(sp.perSource)) {
    for (const k of Object.keys(sp.perSource)) {
      if (!refs.sources.has(k)) warn(`sharePolicy.perSource.${k}`, `references missing data source '${k}'`);
    }
  }
  const auth = isObj(d.authProfile) ? d.authProfile : undefined;
  (Array.isArray(auth?.guards) ? auth.guards : []).forEach((g, gi) => {
    if (!isObj(g)) return;
    if (typeof g.screenId === 'string' && g.screenId && !refs.screens.has(g.screenId)) {
      warn(`authProfile.guards[${gi}].screenId`, `references missing screen '${g.screenId}'`);
    }
    if (typeof g.redirectTo === 'string' && g.redirectTo && !refs.screens.has(g.redirectTo)) {
      warn(`authProfile.guards[${gi}].redirectTo`, `references missing screen '${g.redirectTo}'`);
    }
    if (typeof g.requiresRole === 'string' && g.requiresRole && refs.roles.size && !refs.roles.has(g.requiresRole)) {
      warn(`authProfile.guards[${gi}].requiresRole`, `references undeclared role '${g.requiresRole}'`);
    }
  });
}

/** HARD per-kind action params + SOFT reference targets for one node. */
function validateNodeActions(node: Node, path: string, errors: ComponentTreeError[], warnings: AppDocValidation['warnings'], refs: RefSets): void {
  const actions = node.actions;
  if (actions === undefined) return;
  const bad = (p: string, message: string): void => { errors.push({ path: p, code: 'bad_prop_value', message }); };
  if (!Array.isArray(actions)) { bad(`${path}.actions`, 'actions must be an array'); return; }
  if (actions.length > MAX_ACTIONS_PER_NODE) { errors.push({ path: `${path}.actions`, code: 'illegal_children', message: `at most ${MAX_ACTIONS_PER_NODE} actions per component` }); return; }
  actions.forEach((a, i) => {
    const p = `${path}.actions[${i}]`;
    if (!isObj(a)) { bad(p, 'action must be an object'); return; }
    if (!(typeof a.on === 'string' && ACTION_EVENTS.has(a.on))) bad(`${p}.on`, `on must be one of: ${[...ACTION_EVENTS].join(', ')}`);
    const kind = typeof a.kind === 'string' ? a.kind : '';
    if (!ACTION_KINDS.has(kind)) { bad(`${p}.kind`, `kind must be one of: ${[...ACTION_KINDS].join(', ')}`); return; }
    // Per-kind REQUIRED params (hard — an action without its target is not a
    // legitimate mid-edit state the way a dangling reference is).
    if (kind === 'navigate' && !(typeof a.to === 'string' && a.to)) bad(`${p}.to`, 'a navigate action requires `to` (a screen id)');
    if (kind === 'set-state' && !(typeof a.state === 'string' && WORD_RE.test(a.state))) bad(`${p}.state`, 'a set-state action requires `state` (a state variable id)');
    if (kind === 'invoke-operation' && !(typeof a.operation === 'string' && a.operation)) bad(`${p}.operation`, 'an invoke-operation action requires `operation` (an operation id)');
    if (kind === 'open-modal' && !(typeof a.modal === 'string' && a.modal)) bad(`${p}.modal`, 'an open-modal action requires `modal`');
    // SOFT reference targets.
    if (typeof a.to === 'string' && a.to && !refs.screens.has(a.to)) warnings.push({ path: `${p}.to`, message: `references missing screen '${a.to}'` });
    if (typeof a.state === 'string' && WORD_RE.test(a.state) && !refs.stateVars.has(a.state)) warnings.push({ path: `${p}.state`, message: `references missing state variable '${a.state}'` });
    if (typeof a.operation === 'string' && a.operation && !refs.operations.has(a.operation)) warnings.push({ path: `${p}.operation`, message: `references missing operation '${a.operation}'` });
    for (const f of ['onSuccess', 'onError'] as const) {
      const fu = a[f];
      if (fu === undefined) continue;
      if (!isObj(fu)) { bad(`${p}.${f}`, `${f} must be an object`); continue; }
      if (fu.navigate !== undefined) {
        if (!(typeof fu.navigate === 'string' && fu.navigate && fu.navigate.length <= 80)) bad(`${p}.${f}.navigate`, 'navigate must be a screen id');
        else if (!refs.screens.has(fu.navigate)) warnings.push({ path: `${p}.${f}.navigate`, message: `references missing screen '${fu.navigate}'` });
      }
      if (fu.setState !== undefined) {
        const ss = fu.setState;
        if (!isObj(ss) || !(typeof ss.state === 'string' && WORD_RE.test(ss.state))) bad(`${p}.${f}.setState`, 'setState requires a `state` variable id');
        else if (!refs.stateVars.has(ss.state)) warnings.push({ path: `${p}.${f}.setState`, message: `references missing state variable '${ss.state}'` });
      }
    }
  });
}

/** HARD binding grammar + SOFT path-root resolution for one node. */
function validateNodeBindings(node: Node, path: string, errors: ComponentTreeError[], warnings: AppDocValidation['warnings'], refs: RefSets): void {
  const bindings = node.bindings;
  if (bindings === undefined) return;
  const bad = (p: string, message: string): void => { errors.push({ path: p, code: 'bad_prop_value', message }); };
  if (!isObj(bindings)) { bad(`${path}.bindings`, 'bindings must be an object keyed by prop name'); return; }
  const entries = Object.entries(bindings);
  if (entries.length > MAX_BINDINGS_PER_NODE) { errors.push({ path: `${path}.bindings`, code: 'illegal_children', message: `at most ${MAX_BINDINGS_PER_NODE} bindings per component` }); return; }
  for (const [prop, b] of entries) {
    const p = `${path}.bindings.${prop}`;
    if (!WORD_RE.test(prop)) { bad(p, `bound prop name '${prop.slice(0, 40)}' must match ${String(WORD_RE)}`); continue; }
    if (!isObj(b)) { bad(p, 'binding must be an object'); continue; }
    const bpath = typeof b.path === 'string' ? b.path : '';
    if (!BINDING_PATH_RE.test(bpath)) { bad(`${p}.path`, 'path must match (state|model|op|source).segment[.segment…]'); continue; }
    if (!optStr(b.fallback, 200)) bad(`${p}.fallback`, 'fallback: at most 200 characters');
    if (b.format !== undefined && !(typeof b.format === 'string' && BINDING_FORMATS.has(b.format))) bad(`${p}.format`, `format must be one of: ${[...BINDING_FORMATS].join(', ')}`);
    if (b.mode !== undefined && !(typeof b.mode === 'string' && BINDING_MODES.has(b.mode))) bad(`${p}.mode`, `mode must be one of: ${[...BINDING_MODES].join(', ')}`);
    // SOFT: the path root must resolve against the owning facet.
    const [root, head] = bpath.split('.');
    const missing =
      root === 'state' ? !refs.stateVars.has(head!) :
      root === 'model' ? !refs.models.has(head!) :
      root === 'op' ? !refs.operations.has(head!) :
      !refs.sources.has(head!);
    if (missing) warnings.push({ path: `${p}.path`, message: `references missing ${root === 'op' ? 'operation' : root === 'source' ? 'data source' : root === 'model' ? 'model' : 'state variable'} '${head}'` });
  }
}

function walk(nodes: Node[], base: string, visit: (n: Node, path: string) => void): void {
  nodes.forEach((n, i) => {
    const path = `${base}[${i}]`;
    visit(n, path);
    if (Array.isArray(n.children)) walk(n.children as Node[], `${path}.children`, visit);
  });
}
