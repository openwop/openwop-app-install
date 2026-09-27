/**
 * Form-content pack loader (ADR 0516). A HOST-PRIVATE pack kind
 * (`kind:"form-content"`): distributable FORM TEMPLATES (a title + field list a
 * user instantiates into a new form). Sibling of `canvasContentPackLoader` and a
 * deliberate copy of its pattern — scan roots, kind-filter, bounded validation,
 * in-process registry — including the two lessons that loader learned the hard
 * way: first-root-wins de-duplication (AB-DATA-3) and clear-then-load on reload.
 *
 * Not a widening of `canvas-content`: that kind's body is `canvasTypeId` +
 * `screens` + `connectors`. One loader serving two unrelated body schemas would
 * have to branch inside its validator, and each kind's caps would stop meaning
 * anything. A sibling with its own bounded validator is cheaper and honest.
 *
 * RFC gate: host-private, so NONE — an unrecognized host kind-filters these packs
 * out rather than failing (the ADR 0347 5a precedent). Promotion to a normative
 * cross-host contract is an RFC first (the standing ADR 0342 watch-item).
 *
 * TRUST POSTURE. A form template defines a PUBLIC, unauthenticated submission
 * surface (`/public-forms/:formId`), so safety is enforced in two places:
 *   - HERE, by bounded validation (caps + shape) at load time;
 *   - at INSTANTIATION, by going through `createForm`, whose `sanitizeFields` /
 *     `sanitizeIntakeBinding` are the same code path user input takes.
 * Neither alone is sufficient: this loader cannot know what a field means, and
 * `createForm` cannot know a pack shipped 10,000 of them.
 *
 * @see docs/adr/0516-form-templates-as-a-content-pack.md
 * @see host/canvasContentPackLoader.ts — the pattern this mirrors
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../observability/logger.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';
import { isTombstoned } from './packTombstones.js';
import { locateRepoDir } from './_repoPath.js';
import { isParkedPackDirName } from '../bootstrap/mountLocalPacks.js';
// The ONE field catalog, imported rather than copied. A second list here would
// be the exact drift Phase 2a removed when it unified the 40-vs-50 field cap;
// `host/` importing from `features/` is the established pattern (49 other host
// modules do it), and this loader is already semantically coupled to forms —
// its output feeds `createForm`.

/** RFC 0137 — the WIRE field vocabulary (the RFC 0071 portable subset reused
 *  verbatim, `chat-card-packs.md` §"Input fields"). A pack speaks THIS. */
export const WIRE_TYPES = ['text', 'longtext', 'number', 'boolean', 'select', 'multiselect', 'file', 'artifact-ref'] as const;

/** Wire → host, applied ONCE at the pack boundary.
 *
 *  The wire enum governs the WIRE, not storage. Renaming stored types would
 *  mean a stored `checkbox` coerces to `text` on the next ordinary save — and
 *  `emailOptInField` REQUIRES `checkbox` and throws 400, so every form with a
 *  marketing opt-in becomes unsaveable (ADR 0338 consent machinery). Zero rows
 *  move; the translation lives here instead. */
export const WIRE_TO_HOST: Record<string, string> = {
  text: 'text', longtext: 'textarea', number: 'number', boolean: 'checkbox', select: 'select',
  // Host has no native control for these portable kinds yet — spec §Instantiation
  // #2 says degrade rather than fail, and a plain text input is the named fallback.
  multiselect: 'text', file: 'text', 'artifact-ref': 'text',
};

/** A `vendor.<org>.<kind>` / `x-<kind>` extension. Spec §Instantiation #2: these
 *  MUST degrade to a plain text input rather than fail the instantiation — they
 *  are a FORWARD-COMPAT escape hatch, not malformed input. A bare unknown string
 *  is still refused; that is a typo, and silently turning `emial` into text is
 *  the coercion this loader exists to prevent. */
const isExtensionType = (t: string): boolean => t.startsWith('vendor.') || t.startsWith('x-');

/** Translate one wire field into the host shape. `id`→`key` is wire-only:
 *  `FormField.key` is the SUBMISSION VALUE KEY (`submission.values[key]`) and
 *  `intakeBinding` maps by it, so renaming stored keys would break every
 *  existing submission. */
export function wireFieldToHost(f: Record<string, unknown>): Record<string, unknown> {
  const wire = typeof f.type === 'string' ? f.type : '';
  // `format` is a validation constraint, not a data kind (RFC 0137). The host
  // models email as a TYPE, so `text` + `format:"email"` folds into it.
  const host = wire === 'text' && f.format === 'email' ? 'email' : (WIRE_TO_HOST[wire] ?? 'text');
  const { id, format, ...rest } = f;
  // Keep the WIRE type the template declared. Translation is lossy otherwise,
  // and the declared value is what a conformance witness compares against the
  // control the host chose — `vendor.acme.rating` declared, `text` chosen, is
  // the DEGRADE contract (§Instantiation #2) rather than a silent rewrite.
  return { ...rest, key: typeof id === 'string' ? id : f.key, type: host, declaredType: wire };
}

const log = createLogger('host.formContentPacks');

/** A template field — the `FormField` shape, kept structural so this loader does
 *  not import the forms feature (a host→feature edge). `createForm`'s sanitizer
 *  is the authority on what actually persists. */
export interface FormTemplateField {
  key: string;
  label: string;
  type: string;
  /** The WIRE `fields[].type` the template declared, preserved through
   *  translation. Differs from `type` exactly when the host degraded an
   *  unrecognized `vendor.*` / `x-` extension to a plain text control. */
  declaredType?: string;
  required?: boolean;
  options?: string[];
  /** Help text under the control on the public fill surface. NOT `placeholder`:
   *  ADR 0516 Phase 2a found the loader advertised a `placeholder` that
   *  `sanitizeFields` never read, so every template that set one silently lost it.
   *  `description` is the field that actually persists and renders (wired to
   *  `ui/Field`'s `help` → `aria-describedby`), so templates use the real one. */
  description?: string;
}

export interface FormTemplate {
  templateId: string;
  version: string;
  label: string;
  description?: string;
  /** Pre-filled form title; the user may edit before creating. */
  title: string;
  fields: FormTemplateField[];
  /** Free-text category for grouping in the picker (e.g. 'marketing', 'hr'). */
  category?: string;
}

interface Registered { packName: string; packVersion: string; template: FormTemplate }

/** A form-content registry — the product uses the module-global one; the RFC 0137
 *  conformance seam holds its OWN so fixture templates never reach a real
 *  tenant's catalog (DOCT-12: `ensureFixtures` used to merge conformance
 *  fixtures into the same map every tenant's `GET /form-templates` reads). */
export type FormContentRegistry = Map<string, Registered>;

export function createFormContentRegistry(): FormContentRegistry {
  return new Map<string, Registered>();
}

const TEMPLATES: FormContentRegistry = new Map<string, Registered>(); // templateId → entry

const MAX_TEMPLATES_PER_PACK = 20;
/** Kept at the SERVICE's field cap, not a second opinion. Two numbers for one
 *  concept is a drift waiting to happen: a template that passes the loader must
 *  not then be rejected by `sanitizeFields`, and a loader stricter than the
 *  service silently forbids templates the product allows. */
const MAX_FIELDS_PER_TEMPLATE = 50;
/**
 * These MIRROR the service caps in `features/forms/formsService.ts` and MUST stay
 * equal — `test/form-cap-parity.test.ts` fails if they drift.
 *
 * They are duplicated rather than imported because this loader must not take a
 * host→feature edge (see the file header). The parity test is what makes the
 * duplication safe.
 *
 * WHY THE LOADER REJECTS WHAT THE SERVICE WOULD TRUNCATE. The service truncates
 * because a live form must keep saving. A PACK is different: it is authored ahead
 * of time by someone who can fix it, so silent truncation there is just lying to
 * the template author — they ship 300 options, 50 vanish, and nothing tells them.
 * Load-time refusal names the problem while it is still cheap to fix.
 */
const MAX_LABEL = 1_000;
const MAX_TITLE = 200;
const MAX_OPTIONS = 250;
const MAX_OPTION_LEN = 200;
/** The template's OWN display strings — the picker's label, its description, and
 *  its grouping category.
 *
 *  These are a DIFFERENT risk from the field strings above, and the Phase 2a caps
 *  missed them because the enumeration stopped at `FormTemplateField`. A field
 *  label reaches the public page through `createForm`, so it has TWO layers: this
 *  loader refuses it, and `sanitizeFields` truncates it. These three never become
 *  a `FormDef` at all — `listFormTemplates()` hands the whole template to the
 *  catalog route, which renders it in `TemplateGalleryDialog`. There is NO second
 *  layer, so unbounded here means unbounded all the way to the browser. */
const MAX_TEMPLATE_LABEL = 200;
const MAX_TEMPLATE_DESCRIPTION = 300;
const MAX_TEMPLATE_CATEGORY = 64;
/** RFC 0137 — `templateId` carries a RESERVED SCOPE, verbatim from the wire
 *  schema (`form-content-pack-manifest.schema.json` §FormTemplate). My loader was
 *  LOOSER than the registry on three counts (this, `version`, and field `id`),
 *  which is the dangerous direction: a pack the host accepts would be REJECTED at
 *  publish, so an author finds out from a registry CI failure instead of here.
 *  Exempting a kind from the scope rule would also open a namespace-squat hole. */
const ID_RE = /^(core|vendor|community|private)\.[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+$/;
/** SemVer, matching the wire. Was "any non-empty string". */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Field keys become submission-payload keys; keep them `\w`-safe (RFC 0124 lesson). */
/** Field `id` — verbatim from the wire schema §FormField. */
const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validTemplate(raw: unknown, errors: string[]): raw is FormTemplate {
  const tpl = raw as Partial<FormTemplate> | null;
  if (!tpl || typeof tpl !== 'object') { errors.push('template must be an object'); return false; }
  if (typeof tpl.templateId !== 'string' || !ID_RE.test(tpl.templateId)) { errors.push('templateId must be an id slug'); return false; }
  if (typeof tpl.version !== 'string' || !VERSION_RE.test(tpl.version)) { errors.push(`${tpl.templateId}: version must be SemVer`); return false; }
  if (typeof tpl.label !== 'string' || !tpl.label) { errors.push(`${tpl.templateId}: label required`); return false; }
  if (tpl.label.length > MAX_TEMPLATE_LABEL) { errors.push(`${tpl.templateId}: label must be <= ${MAX_TEMPLATE_LABEL} chars (it renders in the picker)`); return false; }
  if (tpl.description !== undefined && (typeof tpl.description !== 'string' || tpl.description.length > MAX_TEMPLATE_DESCRIPTION)) {
    errors.push(`${tpl.templateId}: description must be a string <= ${MAX_TEMPLATE_DESCRIPTION} chars (it renders in the picker)`);
    return false;
  }
  if (tpl.category !== undefined && (typeof tpl.category !== 'string' || tpl.category.length > MAX_TEMPLATE_CATEGORY)) {
    errors.push(`${tpl.templateId}: category must be a string <= ${MAX_TEMPLATE_CATEGORY} chars (it renders in the picker)`);
    return false;
  }
  if (typeof tpl.title !== 'string' || !tpl.title) { errors.push(`${tpl.templateId}: title required`); return false; }
  if (tpl.title.length > MAX_TITLE) { errors.push(`${tpl.templateId}: title must be <= ${MAX_TITLE} chars (the service would truncate it)`); return false; }
  if (!Array.isArray(tpl.fields) || tpl.fields.length < 1 || tpl.fields.length > MAX_FIELDS_PER_TEMPLATE) {
    errors.push(`${tpl.templateId}: fields must be 1..${MAX_FIELDS_PER_TEMPLATE}`);
    return false;
  }
  const seen = new Set<string>();
  for (const f of tpl.fields) {
    if (!f || typeof f !== 'object') { errors.push(`${tpl.templateId}: field must be an object`); return false; }
    // RFC 0137 — the WIRE field is `id`. It becomes `key` in storage
    // (`wireFieldToHost`), because `FormField.key` is the submission value key
    // and renaming stored keys would break every existing submission.
    // Read the WIRE record, not the registered shape — `FormTemplateField`
    // describes what the catalog EMITS (host `key`), and this runs before
    // translation on what the pack SHIPPED (wire `id`).
    const wf = f as unknown as Record<string, unknown>;
    const wid = typeof wf.id === 'string' ? wf.id : '';
    if (!KEY_RE.test(wid)) { errors.push(`${tpl.templateId}: field ids must match ${String(KEY_RE)}`); return false; }
    // A duplicate key would silently overwrite a submitted value — the template
    // must not be able to author that ambiguity.
    if (seen.has(wid)) { errors.push(`${tpl.templateId}: duplicate field id '${wid}'`); return false; }
    seen.add(wid);
    if (typeof f.label !== 'string' || !f.label) { errors.push(`${tpl.templateId}: field '${wid}' needs a label`); return false; }
    if (f.label.length > MAX_LABEL) { errors.push(`${tpl.templateId}: field '${wid}' label must be <= ${MAX_LABEL} chars (the service would truncate it)`); return false; }
    if (f.options !== undefined) {
      if (!Array.isArray(f.options) || f.options.length > MAX_OPTIONS) { errors.push(`${tpl.templateId}: field '${wid}' may have at most ${MAX_OPTIONS} options (the service would truncate)`); return false; }
      if (f.options.some((o) => typeof o !== 'string' || o.length > MAX_OPTION_LEN)) { errors.push(`${tpl.templateId}: field '${wid}' options must be strings <= ${MAX_OPTION_LEN} chars`); return false; }
    }
    if (typeof f.type !== 'string' || !f.type) { errors.push(`${tpl.templateId}: field '${wid}' needs a type`); return false; }
    // The field catalog is CLOSED and the service silently rewrites anything
    // outside it (`sanitizeFields`: an unknown type becomes 'text'). Refusing
    // here rather than letting that happen is the same rule the caps above
    // follow — the loader refuses what the service would silently change.
    //
    // Coercion is not a graceful degradation, which is why this is a refusal
    // and not a warning: `sanitizeFields` attaches `options` ONLY for 'select',
    // so a template declaring 'radio'/'multiselect'/'dropdown' loses its options
    // ENTIRELY and a closed choice set becomes an unconstrained free-text box on
    // a PUBLIC page. A template author who guesses a plausible-but-wrong type
    // must find out at load, by name, not by reading submissions later.
    // RFC 0137: a pack speaks the WIRE vocabulary. An extension type degrades
    // (spec §Instantiation #2); a bare unknown string is a typo and is refused.
    if (!(WIRE_TYPES as readonly string[]).includes(f.type) && !isExtensionType(f.type)) {
      errors.push(`${tpl.templateId}: field '${wid}' has unknown type '${f.type}' (allowed: ${WIRE_TYPES.join(', ')}, or a vendor.*/x- extension)`);
      return false;
    }
    // Same family, milder blast radius: the service reads `f.required === true`,
    // so a string "true" or a 1 silently becomes FALSE and a field the author
    // meant to require quietly stops being collected.
    if (f.required !== undefined && typeof f.required !== 'boolean') {
      errors.push(`${tpl.templateId}: field '${wid}' required must be a boolean (the service would read a non-boolean as false)`);
      return false;
    }
  }
  // ADR 0516 §Security — routing submissions into a CRM list is a decision about
  // the OPERATOR's data. A third-party template does not get to make it on their
  // behalf, so a kit declaring one is rejected outright rather than stripped: a
  // template that tried is a template whose intent should be reviewed.
  if ((raw as Record<string, unknown>).intakeBinding !== undefined) {
    errors.push(`${tpl.templateId}: templates must not declare an intakeBinding`);
    return false;
  }
  return true;
}

export interface FormContentLoadOutcome {
  installed: { packName: string; packVersion: string; templateIds: string[] }[];
  errors: { pack: string; code: string; message: string }[];
}

export function defaultFormContentPackRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'core.openwop.artifact-types/pack.json'));
  } catch { /* outside the workspace (Cloud Run image) — registry dir below still applies */ }
  roots.push(resolveDefaultPackDir());
  if (process.env.OPENWOP_FORM_CONTENT_PACKS_DIR) roots.push(process.env.OPENWOP_FORM_CONTENT_PACKS_DIR);
  return [...new Set(roots)];
}

export function loadFormContentPacks(opts: { roots: string[]; registry?: FormContentRegistry }): FormContentLoadOutcome {
  const registry = opts.registry ?? TEMPLATES;
  const outcome: FormContentLoadOutcome = { installed: [], errors: [] };
  // First root wins — the same pack readable via BOTH the repo `packs/` dir and the
  // mounted pack dir must register once (the AB-DATA-3 lesson; without this the boot
  // outcome double-counts).
  const seenPacks = new Set<string>();
  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (isParkedPackDirName(dir)) continue;
      const packJson = join(root, dir, 'pack.json');
      try {
        if (!existsSync(packJson) || !statSync(join(root, dir)).isDirectory()) continue;
        const manifest = JSON.parse(readFileSync(packJson, 'utf8')) as { name?: string; version?: string; kind?: string; templates?: unknown[] };
        if (manifest.kind !== 'form-content') continue;
        const packName = typeof manifest.name === 'string' ? manifest.name : dir;
        if (seenPacks.has(packName)) continue;
        seenPacks.add(packName);
        if (isTombstoned(packName)) { log.info('form_content_pack_tombstoned', { pack: packName }); continue; }
        const rawTemplates = Array.isArray(manifest.templates) ? manifest.templates : [];
        if (rawTemplates.length > MAX_TEMPLATES_PER_PACK) {
          outcome.errors.push({ pack: packName, code: 'form_content_pack_invalid', message: `at most ${MAX_TEMPLATES_PER_PACK} templates per pack` });
          continue;
        }
        const errors: string[] = [];
        const templateIds: string[] = [];
        for (const raw of rawTemplates) {
          if (!validTemplate(raw, errors)) continue;
          const existing = registry.get(raw.templateId);
          if (existing && existing.packName !== packName) {
            outcome.errors.push({ pack: packName, code: 'form_content_template_conflict', message: `template '${raw.templateId}' already registered by ${existing.packName}` });
            continue;
          }
          // Translate WIRE → HOST once, here, before anything downstream sees it.
          // Everything past this line (the catalog route, the picker, createForm)
          // speaks host vocabulary; only this loader knows the wire names.
          const translated = {
            ...raw,
            fields: (raw.fields as unknown as Record<string, unknown>[]).map(wireFieldToHost),
          } as unknown as FormTemplate;
          registry.set(raw.templateId, { packName, packVersion: String(manifest.version ?? '0.0.0'), template: translated });
          templateIds.push(raw.templateId);
        }
        if (errors.length) outcome.errors.push({ pack: packName, code: 'form_content_pack_invalid', message: errors.slice(0, 3).join('; ') });
        if (templateIds.length) outcome.installed.push({ packName, packVersion: String(manifest.version ?? '0.0.0'), templateIds });
      } catch (err) {
        outcome.errors.push({ pack: dir, code: 'form_content_pack_unreadable', message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return outcome;
}

/** Every registered form template (the picker's catalog). */
export function listFormTemplates(): FormTemplate[] {
  return [...TEMPLATES.values()].map((r) => r.template);
}

/** The catalog WITH its pack provenance (DOCTPL-19) — what the gallery renders
 *  as the source chip. The registry has always known the pack (it needs it for
 *  the conflict check); surfacing it is the cheap half of the ADR 0516
 *  §Provenance residual ("a hostile template can still phish" — attribution is
 *  the mitigation a sanitizer cannot provide). */
export function listFormTemplateEntries(): Array<FormTemplate & { packName: string; packVersion: string }> {
  return [...TEMPLATES.values()].map((r) => ({ ...r.template, packName: r.packName, packVersion: r.packVersion }));
}

/** One template by id, or null. Callers MUST instantiate via `createForm`. */
export function getFormTemplate(templateId: string): FormTemplate | null {
  return TEMPLATES.get(templateId)?.template ?? null;
}

/** One template WITH the pack that supplied it, or null.
 *
 * The instantiating route uses this rather than `getFormTemplate` so the form it
 * creates can record where its fields came from. The registry has always known
 * the pack + version (it needs them for the cross-pack conflict check above);
 * before ADR 0516 §Provenance that was discarded at the write, which is
 * information no later pass could recover — a form is a COPY, so once the row
 * exists there is nothing left to infer the origin from. If a published template
 * later proves harmful (the phishing-label case no sanitizer can catch), this
 * stamp is what turns "which forms are affected?" from a guess into a query. */
export function getFormTemplateEntry(
  templateId: string,
  registry: FormContentRegistry = TEMPLATES,
): { template: FormTemplate; packName: string; packVersion: string; templateVersion: string } | null {
  const entry = registry.get(templateId);
  return entry
    ? {
        template: entry.template,
        packName: entry.packName,
        packVersion: entry.packVersion,
        // The template's OWN version. The loader has always REQUIRED authors to
        // supply this and then consumed it nowhere — a field demanded and
        // ignored, which is the same dishonesty as one advertised and unread.
        // Recording it makes provenance answer the more precise question: not
        // just which pack release, but which revision of THIS template.
        templateVersion: entry.template.version,
      }
    : null;
}

/** Full reload — clear-then-load. Without the clear, a template REMOVED from a
 *  still-present pack would survive as a stale registry entry. */
export function reloadFormContentPacks(opts: { roots: string[] }): FormContentLoadOutcome {
  TEMPLATES.clear();
  return loadFormContentPacks(opts);
}

/** Test seam. */
export function _resetFormContentRegistryForTest(): void {
  TEMPLATES.clear();
}
