/**
 * Artifact-type pack loader (ADR 0055 Phase 3 / RFC 0075 `kind:'artifact-type'`).
 * Scans pack roots for `kind:'artifact-type'` manifests and registers their declared
 * types into the SAME host registry as native types (`registerArtifactType`,
 * `registrationSource:'pack'`) — no parallel registry. Mirrors the connection-pack
 * loader's posture: per-pack / per-type failures are ISOLATED (logged + collected,
 * never thrown) so one malformed pack can't abort boot.
 *
 * Manifest shape:
 *   { "name", "version", "kind": "artifact-type",
 *     "artifactTypes": [ { "artifactTypeId", "title?", "schema", "export?": string[],
 *                          "x-openwop-app.canvas"?: { "catalog?": ComponentDef[],
 *                                                     "editor?": PackCanvasEditorHints } } ] }
 *
 * ADR 0310 Phase D: the OPTIONAL `x-openwop-app.canvas` vendor extension (the
 * RFC 0124 `x-openwop-sensitive` precedent) declares the type as an editable
 * CANVAS — a component catalog (agent prompt + closed-world validation) and/or
 * elements-trait editor hints, all pure data. Malformed extensions are isolated
 * like every other pack failure: the artifact type still registers, the canvas
 * half is skipped with a warning.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../observability/logger.js';
import { registerArtifactType, getArtifactType, type ArtifactType } from './artifactTypes.js';
import type { ComponentDef } from './canvasComponentCatalog.js';
import { registerPackCanvasType, type PackCanvasEditorHints, type PackElementsCollection, type PackPropDef } from './canvasPackTypes.js';
import { isParkedPackDirName } from '../bootstrap/mountLocalPacks.js';

const log = createLogger('host.artifactTypePackLoader');

export interface ArtifactTypePackOutcome {
  /** artifactTypeIds registered on this run. */
  registered: string[];
  /** Per-pack/per-type rejections (isolated; boot continues). */
  errors: Array<{ pack: string; message: string }>;
}

/** Default roots: the mounted/installed pack dir (`OPENWOP_PACK_DIR` or
 *  `~/.openwop-packs` — where mountLocalPacks symlinks the repo's vendored packs)
 *  plus an operator override. Non-existent roots are skipped. */
export function defaultArtifactTypePackRoots(): string[] {
  return [
    process.env.OPENWOP_PACK_DIR ?? join(homedir(), '.openwop-packs'),
    process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR ?? '',
  ].filter((p) => p.length > 0);
}

/** First non-empty string among the candidates — dialect key first, canonical second. */
function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** First array-of-strings among the candidates, filtered to strings. */
function pickStringArray(...vals: unknown[]): string[] {
  for (const v of vals) if (Array.isArray(v)) return v.filter((e): e is string => typeof e === 'string');
  return [];
}

export function loadArtifactTypePacks(opts: { roots: string[] }): ArtifactTypePackOutcome {
  const registered: string[] = [];
  const errors: ArtifactTypePackOutcome['errors'] = [];
  const seenPacks = new Set<string>();

  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (isParkedPackDirName(entry)) continue; // shadow-pass leftovers are recoverable, never loadable
      const dir = join(root, entry);
      let st;
      try { st = statSync(dir); } catch { continue; }
      const manifestPath = join(dir, 'pack.json');
      if (!st.isDirectory() || !existsSync(manifestPath)) continue;

      let raw: unknown;
      try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
      if (!raw || typeof raw !== 'object' || (raw as { kind?: string }).kind !== 'artifact-type') continue;

      const packName = (raw as { name?: string }).name ?? entry;
      if (seenPacks.has(packName)) continue; // first root wins
      seenPacks.add(packName);

      const types = (raw as { artifactTypes?: unknown }).artifactTypes;
      if (!Array.isArray(types)) {
        errors.push({ pack: packName, message: 'artifact-type pack missing `artifactTypes[]`' });
        log.warn('rejected artifact-type pack', { pack: packName, message: 'missing artifactTypes[]' });
        continue;
      }
      for (const t of types) {
        try {
          const at = (t ?? {}) as Partial<ArtifactType>;
          if (typeof at.artifactTypeId !== 'string' || !at.artifactTypeId.trim()) throw new Error('`artifactTypeId` is required');

          // RFC 0071 `schemaRef` — a path resolved RELATIVE TO THE PACK DIR.
          //
          // This loader originally accepted an INLINE `schema` only, which is a
          // non-standard variant: every pack this repo ships uses the inline
          // shape, so nothing internal ever noticed, while a standards-conformant
          // third-party pack was silently rejected (`artifactTypes[]` present, no
          // type registered). The RFC 0071 conformance leg catches exactly this —
          // it had never run against this host because the behavioral seam was
          // unwired, so the defect stayed invisible. Inline `schema` stays
          // supported; `schemaRef` is additive, so no shipped pack changes.
          //
          // The ref is confined to the pack directory: a `..` escape or an
          // absolute path is refused rather than read.
          if (at.schema == null && typeof (t as { schemaRef?: unknown }).schemaRef === 'string') {
            const ref = (t as { schemaRef: string }).schemaRef;
            const resolved = resolve(dir, ref);
            if (!resolved.startsWith(resolve(dir) + sep)) {
              throw new Error(`type \`${at.artifactTypeId}\`: \`schemaRef\` escapes the pack directory`);
            }
            if (!existsSync(resolved)) throw new Error(`type \`${at.artifactTypeId}\`: \`schemaRef\` not found (${ref})`);
            let parsed: unknown;
            try { parsed = JSON.parse(readFileSync(resolved, 'utf8')); } catch {
              throw new Error(`type \`${at.artifactTypeId}\`: \`schemaRef\` is not valid JSON (${ref})`);
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error(`type \`${at.artifactTypeId}\`: \`schemaRef\` must resolve to a JSON Schema object`);
            }
            at.schema = parsed as Record<string, unknown>;
          }

          if (at.schema == null || typeof at.schema !== 'object' || Array.isArray(at.schema)) throw new Error(`type \`${at.artifactTypeId}\`: \`schema\` must be a JSON Schema object (inline \`schema\` or RFC 0071 \`schemaRef\`)`);
          // A pack MUST NOT silently override a HOST-native type — that could weaken a
          // built-in schema (and a stray pack symlinked into the shared pack dir from
          // another checkout is the parallel-worktree hazard). Preserve native; skip + warn.
          const prior = getArtifactType(at.artifactTypeId);
          if (prior && prior.registrationSource === 'host') {
            errors.push({ pack: packName, message: `type \`${at.artifactTypeId}\` collides with a host-native type — skipped` });
            log.warn('artifact-type pack tried to override a host-native type; skipped', { pack: packName, artifactTypeId: at.artifactTypeId });
            continue;
          }
          registerArtifactType({
            artifactTypeId: at.artifactTypeId,
            // Canonical vocabulary vs host dialect. `artifact-type-pack-manifest.schema.json`
            // `$defs/ArtifactType` names these `displayName` and `exportFormats`; this
            // loader has always read `title`/`export`. Both are accepted, dialect FIRST
            // so no shipped pack changes meaning.
            //
            // This ordering is load-bearing for the migration that follows (PMC-4):
            // migrating a pack to the canonical keys BEFORE the loader understood them
            // would have silently dropped its title and export facets — a rename that
            // degrades data rather than failing. Aliases land first, packs move second.
            title: pickString(at.title, (t as Record<string, unknown>)['displayName']) ?? at.artifactTypeId,
            schema: at.schema as Record<string, unknown>,
            export: pickStringArray(at.export, (t as Record<string, unknown>)['exportFormats']),
            registrationSource: 'pack',
          });
          registered.push(at.artifactTypeId);
          // ADR 0310 Phase D — the optional canvas vendor extension. Isolated:
          // a malformed extension never un-registers the artifact type.
          const ext = (t as Record<string, unknown>)['x-openwop-app.canvas'];
          if (ext !== undefined) {
            try {
              applyCanvasExtension(packName, at.artifactTypeId, ext);
            } catch (err) {
              const message = `type \`${at.artifactTypeId}\`: x-openwop-app.canvas rejected — ${err instanceof Error ? err.message : String(err)}`;
              errors.push({ pack: packName, message });
              log.warn('rejected canvas extension from pack', { pack: packName, artifactTypeId: at.artifactTypeId, message });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ pack: packName, message });
          log.warn('rejected artifact type from pack', { pack: packName, message });
        }
      }
    }
  }
  if (registered.length) log.info('artifact_type_packs_loaded', { count: registered.length, types: registered });
  return { registered, errors };
}

/** A pack canvasTypeId lands in ROUTE PATHS (`/canvas-packs/<id>/…`) and in the
 *  FE URL — constrain it to a strict slug so a crafted id can't inject path
 *  segments, params, or route metacharacters. */
const CANVAS_TYPE_ID_RE = /^canvas\.[a-z0-9][a-z0-9-]{0,63}$/;

/** Field names become object keys the editor writes — never the prototype chain. */
const UNSAFE_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Narrow one PackPropDef from pack data (throws on a malformed field). */
function packPropDef(raw: unknown, where: string): PackPropDef {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name) throw new Error(`${where}: field \`name\` is required`);
  if (UNSAFE_FIELD_NAMES.has(p.name)) throw new Error(`${where}: field name \`${p.name}\` is not allowed`);
  if (typeof p.type !== 'string' || !p.type) throw new Error(`${where}.${p.name}: field \`type\` is required`);
  return {
    name: p.name,
    type: p.type,
    ...(typeof p.label === 'string' ? { label: p.label } : {}),
    ...(Array.isArray(p.options) ? { options: p.options.filter((o): o is string => typeof o === 'string') } : {}),
    ...(p.required === true ? { required: true } : {}),
  };
}

/** Bounds on pack editor data — a pathological pack must not render unbounded
 *  UI or bloat the prompt schema. */
const MAX_COLLECTIONS = 8;
const MAX_ADDERS = 24;
const MAX_FIELDS = 64;
const MAX_CATALOG = 128;

/** Parse + STASH the `x-openwop-app.canvas` extension in the pack canvas-type
 *  registry (ADR 0310 Phase D — tree/frames pack editing is the recorded
 *  follow-up). Nothing is applied to the shared canvasComponentCatalog here:
 *  host features register AFTER this loader, so ownership is undecidable at
 *  load time — the `canvas-packs` feature applies catalog + routes later,
 *  behind one host-wins check. Throws on malformed data; the caller isolates. */
function applyCanvasExtension(packName: string, canvasTypeId: string, ext: unknown): void {
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) throw new Error('extension must be an object');
  if (!CANVAS_TYPE_ID_RE.test(canvasTypeId)) {
    throw new Error('the canvas extension needs a `canvas.<slug>` artifactTypeId (lowercase a-z, 0-9, dashes; max 64)');
  }
  const e = ext as Record<string, unknown>;

  let catalog: ComponentDef[] | undefined;
  if (e.catalog !== undefined) {
    if (!Array.isArray(e.catalog)) throw new Error('`catalog` must be a ComponentDef array');
    if (e.catalog.length > MAX_CATALOG) throw new Error(`\`catalog\` holds at most ${MAX_CATALOG} components`);
    catalog = e.catalog.map((c, i) => {
      const d = (c ?? {}) as Record<string, unknown>;
      if (typeof d.type !== 'string' || !d.type) throw new Error(`catalog[${i}]: \`type\` is required`);
      if (typeof d.label !== 'string' || !d.label) throw new Error(`catalog[${i}]: \`label\` is required`);
      if (typeof d.category !== 'string' || !d.category) throw new Error(`catalog[${i}]: \`category\` is required`);
      return {
        type: d.type,
        label: d.label,
        category: d.category,
        ...(typeof d.description === 'string' ? { description: d.description } : {}),
        ...(d.acceptsChildren === true ? { acceptsChildren: true } : {}),
        ...(Array.isArray(d.props) ? { props: d.props.map((p, j) => packPropDef(p, `catalog[${i}].props[${j}]`)) } : {}),
      } as ComponentDef;
    });
  }

  let editor: PackCanvasEditorHints | undefined;
  if (e.editor !== undefined) {
    const ed = (e.editor ?? {}) as Record<string, unknown>;
    if (!Array.isArray(ed.collections) || ed.collections.length === 0) {
      throw new Error('`editor.collections` (the elements trait) is required — Phase D supports elements-trait pack editors only');
    }
    if (ed.collections.length > MAX_COLLECTIONS) throw new Error(`\`editor.collections\` holds at most ${MAX_COLLECTIONS} collections`);
    const collections: PackElementsCollection[] = ed.collections.map((c, i) => {
      const col = (c ?? {}) as Record<string, unknown>;
      if (typeof col.key !== 'string' || !col.key) throw new Error(`collections[${i}]: \`key\` is required`);
      if (typeof col.label !== 'string' || !col.label) throw new Error(`collections[${i}]: \`label\` is required`);
      if (typeof col.max !== 'number' || col.max < 1) throw new Error(`collections[${i}]: \`max\` must be a positive number`);
      if (!Array.isArray(col.adders) || col.adders.length === 0) throw new Error(`collections[${i}]: \`adders\` is required`);
      if (col.adders.length > MAX_ADDERS) throw new Error(`collections[${i}]: at most ${MAX_ADDERS} adders`);
      if (!Array.isArray(col.fields)) throw new Error(`collections[${i}]: \`fields\` is required`);
      if (col.fields.length > MAX_FIELDS) throw new Error(`collections[${i}]: at most ${MAX_FIELDS} fields`);
      if (UNSAFE_FIELD_NAMES.has(col.key)) throw new Error(`collections[${i}]: key \`${col.key}\` is not allowed`);
      return {
        key: col.key,
        label: col.label,
        max: col.max,
        ...(typeof col.min === 'number' && col.min >= 0 ? { min: col.min } : {}),
        ...(typeof col.itemLabelField === 'string' ? { itemLabelField: col.itemLabelField } : {}),
        adders: col.adders.map((a, j) => {
          const ad = (a ?? {}) as Record<string, unknown>;
          if (typeof ad.id !== 'string' || !ad.id) throw new Error(`collections[${i}].adders[${j}]: \`id\` is required`);
          if (typeof ad.label !== 'string' || !ad.label) throw new Error(`collections[${i}].adders[${j}]: \`label\` is required`);
          const raw = ad.defaults && typeof ad.defaults === 'object' && !Array.isArray(ad.defaults) ? (ad.defaults as Record<string, unknown>) : {};
          // Defense-in-depth (grade pass GC-CV-5): adder defaults become object
          // keys the editor writes — screen the prototype-chain names here too.
          const defaults = Object.fromEntries(Object.entries(raw).filter(([k]) => !UNSAFE_FIELD_NAMES.has(k)));
          return { id: ad.id, label: ad.label, defaults };
        }),
        fields: col.fields.map((f, j) => packPropDef(f, `collections[${i}].fields[${j}]`)),
      };
    });
    editor = {
      ...(typeof ed.docNameKey === 'string' && ed.docNameKey && !UNSAFE_FIELD_NAMES.has(ed.docNameKey) ? { docNameKey: ed.docNameKey } : {}),
      ...(Array.isArray(ed.docPropDefs) ? { docPropDefs: ed.docPropDefs.map((p, i) => packPropDef(p, `docPropDefs[${i}]`)) } : {}),
      collections,
    };
  }

  if (!catalog && !editor) throw new Error('the extension needs `catalog` and/or `editor`');
  const { replaced } = registerPackCanvasType({ canvasTypeId, packName, ...(catalog ? { catalog } : {}), ...(editor ? { editor } : {}) });
  if (replaced) log.warn('canvas pack type re-declared — last pack wins', { pack: packName, canvasTypeId });
  log.info('canvas_pack_type_stashed', { pack: packName, canvasTypeId, hasCatalog: Boolean(catalog), hasEditor: Boolean(editor) });
}
