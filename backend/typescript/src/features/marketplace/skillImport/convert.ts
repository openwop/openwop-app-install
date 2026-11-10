/**
 * ADR 1044 D7 / D8 / D9 — frontmatter → a validated Skill manifest.
 *
 * Closed world: every frontmatter key is either mapped, explicitly ignored (and
 * listed), or refused. Every tool resolves to a tool registered on this host or
 * the import is refused. The manifest is validated against the vendored
 * `agent-manifest.schema.json`, whose RFC 0131 Skill profile binds `role:"skill"`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { locateRepoSchemasDir } from '../../../host/_repoPath.js';
import type { FmMap, FmValue } from './frontmatter.js';
import { refuse } from './refusal.js';

/** RFC 0131 + the bridge's adapter contract (`core.openwop.skills-bridge` 1.0.2):
 *  the typed handoff an imported skill is invoked through. */
export const SKILL_HANDOFF = {
  taskSchemaRef: 'https://packs.openwop.dev/core.openwop.skills-bridge/1.0.2/adapter.task.schema.json',
  returnSchemaRef: 'https://packs.openwop.dev/core.openwop.skills-bridge/1.0.2/adapter.return.schema.json',
} as const;

/** The portable id prefix (the spec's `private.` namespace tier). */
export const PORTABLE_ID_PREFIX = 'private.imported-skills';

/** agentskills.io: 1–64 chars, lowercase letters, digits, single hyphens, no edge hyphen. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

/** Keys kept only in provenance. */
const PROVENANCE_KEYS = new Set(['license', 'compatibility', 'version']);
/** Keys with no meaning on this host: ignored, and listed so the admin sees it. */
const IGNORED_KEYS = new Set(['model', 'disable-model-invocation', 'user-invocable', 'argument-hint', 'homepage']);
const TOOL_KEYS = ['allowed-tools', 'allowed_tools'] as const;
const MAPPED_KEYS = new Set(['name', 'description', 'metadata', ...TOOL_KEYS]);

/** Claude Code tool names. `WebSearch` has an equivalent here; the rest need a
 *  local shell or file system, which this host does not give agents. */
const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = { WebSearch: 'openwop:ai.research.web' };
const CLAUDE_LOCAL_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'WebFetch', 'NotebookEdit', 'NotebookRead', 'Task', 'TodoWrite', 'KillShell', 'BashOutput']);

/** Registered tools an import can never grant itself (ADR 1044 D8): code
 *  execution and raw egress. An admin can still grant them via ADR 0104. */
export const IMPORT_NOT_GRANTABLE_TOOLS: ReadonlySet<string> = new Set([
  'openwop:feature.code-exec.nodes.run',
  'openwop:core.openwop.http.fetch',
]);

const OPENCLAW_KEYS = ['openclaw', 'clawdbot'] as const;
const OPENCLAW_REQUIRE_KEYS = new Set(['bins', 'anyBins', 'env', 'config']);
const OPENCLAW_IGNORED = new Set(['os', 'emoji', 'homepage', 'always', 'skillKey', 'primaryEnv']);

export interface SkillManifest {
  agentId: string;
  persona: string;
  label: string;
  description: string;
  modelClass: 'general';
  role: 'skill';
  systemPrompt: string;
  toolAllowlist: string[];
  memoryShape: { scratchpad: true; conversation: false; longTerm: false };
  handoff: typeof SKILL_HANDOFF;
}

export interface Conversion {
  name: string;
  manifest: SkillManifest;
  /** Frontmatter paths that were read and deliberately not used. */
  ignored: string[];
  provenance: Record<string, string>;
}

const isMap = (v: FmValue | undefined): v is FmMap => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: FmValue | undefined): boolean =>
  v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'string' && v.trim() === '') && !(isMap(v) && Object.keys(v).length === 0);

function scalarText(v: FmValue | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  return undefined;
}

/** `allowed-tools` is a space- or comma-delimited string (agentskills.io) or a list. */
function toolEntries(v: FmValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).map((s) => s.trim()).filter(Boolean);
  throw refuse('frontmatter_invalid', '`allowed-tools` must be a string or a list of strings.');
}

export function resolveTools(entries: readonly string[], registered: readonly string[]): string[] {
  const known = new Set(registered);
  const out: string[] = [];
  for (const raw of entries) {
    const base = raw.replace(/\(.*\)$/, ''); // `Bash(git status:*)` → `Bash`
    if (CLAUDE_LOCAL_TOOLS.has(base)) {
      throw refuse('tool_unavailable', `Tool "${raw}" needs a local shell or file system, which this host does not give agents.`, { tool: raw });
    }
    const id = CLAUDE_TOOL_MAP[base] ?? raw;
    if (!id.startsWith('openwop:') || !known.has(id)) {
      throw refuse('tool_unknown', `Tool "${raw}" is not a tool on this host. Use a registered \`openwop:<id>\` tool or remove it.`, { tool: raw });
    }
    if (IMPORT_NOT_GRANTABLE_TOOLS.has(id)) {
      throw refuse('tool_not_grantable', `Tool "${raw}" (code execution or raw network egress) cannot be granted by an imported skill. An admin can grant it separately after import.`, { tool: raw });
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** OpenClaw / ClawHub `metadata.openclaw` gating (ADR 1044 D7 table). */
function readOpenClaw(key: string, oc: FmValue, ignored: string[]): void {
  if (!isMap(oc)) {
    ignored.push(`metadata.${key}`);
    return;
  }
  for (const [k, v] of Object.entries(oc)) {
    const path = `metadata.${key}.${k}`;
    if (k === 'install') {
      if (nonEmpty(v)) throw refuse('installer_refused', `\`${path}\` asks the host to run installers. This host never installs software for a skill.`, { field: path });
      continue;
    }
    if (k === 'requires') {
      if (v === null) continue;
      if (!isMap(v)) throw refuse('frontmatter_invalid', `\`${path}\` must be a mapping.`, { field: path });
      for (const [rk, rv] of Object.entries(v)) {
        const rpath = `${path}.${rk}`;
        if (!OPENCLAW_REQUIRE_KEYS.has(rk)) {
          // An unknown requirement cannot be shown to be met, so it fails closed.
          if (nonEmpty(rv)) throw refuse('requirement_unmet', `\`${rpath}\` is a requirement this host does not know how to meet.`, { field: rpath });
          continue;
        }
        if (nonEmpty(rv)) {
          const what = rk === 'env' ? 'environment variables' : rk === 'config' ? 'local configuration files' : 'local binaries';
          throw refuse('requirement_unmet', `\`${rpath}\` needs ${what}. Agents on this host have no shell, binaries or environment; secrets go through Connections.`, { field: rpath });
        }
      }
      continue;
    }
    if (OPENCLAW_IGNORED.has(k)) { ignored.push(path); continue; }
    ignored.push(path);
  }
}

export function convertFrontmatter(fm: FmMap, body: string, registeredTools: readonly string[]): Conversion {
  const ignored: string[] = [];
  const provenance: Record<string, string> = {};

  for (const key of Object.keys(fm)) {
    if (key === 'hooks') throw refuse('hooks_refused', 'Frontmatter `hooks` runs commands. Skills with hooks cannot be imported.', { field: 'hooks' });
    if (key === 'scripts') throw refuse('scripts_refused', 'Frontmatter `scripts` declares executable scripts. Skills with scripts cannot be imported.', { field: 'scripts' });
    if (MAPPED_KEYS.has(key)) continue;
    if (PROVENANCE_KEYS.has(key)) {
      const t = scalarText(fm[key]);
      if (t !== undefined) provenance[key] = t.slice(0, 500);
      continue;
    }
    if (IGNORED_KEYS.has(key)) { ignored.push(key); continue; }
    throw refuse('frontmatter_unknown_key', `Frontmatter key \`${key}\` is not a SKILL.md field this host knows.`, { field: key });
  }
  if (fm['allowed-tools'] !== undefined && fm.allowed_tools !== undefined) {
    throw refuse('frontmatter_invalid', 'Use `allowed-tools` or `allowed_tools`, not both.');
  }

  const name = scalarText(fm.name)?.trim() ?? '';
  if (!name || name.length > NAME_MAX || !NAME_RE.test(name)) {
    throw refuse('name_invalid', '`name` is required: 1–64 lowercase letters, digits and single hyphens (agentskills.io).', { name: name.slice(0, 80) });
  }
  const description = scalarText(fm.description)?.trim() ?? '';
  if (!description) throw refuse('description_missing', '`description` is required: it tells the model when to use the skill.');
  if (description.length > DESCRIPTION_MAX) throw refuse('frontmatter_invalid', `\`description\` is longer than ${DESCRIPTION_MAX} characters.`);

  const metadata = fm.metadata;
  if (metadata !== undefined && metadata !== null) {
    if (!isMap(metadata)) throw refuse('frontmatter_invalid', '`metadata` must be a mapping.');
    for (const [k, v] of Object.entries(metadata)) {
      if ((OPENCLAW_KEYS as readonly string[]).includes(k)) readOpenClaw(k, v, ignored);
      else ignored.push(`metadata.${k}`);
    }
  }

  const instructions = body.trim();
  if (instructions.length === 0) throw refuse('empty_instructions', 'SKILL.md has no instructions after the frontmatter.');

  const toolAllowlist = resolveTools(toolEntries(fm['allowed-tools'] ?? fm.allowed_tools), registeredTools);

  const manifest: SkillManifest = {
    agentId: `${PORTABLE_ID_PREFIX}.${name}`,
    persona: name,
    label: name,
    description,
    modelClass: 'general',
    role: 'skill',
    systemPrompt: instructions,
    toolAllowlist,
    memoryShape: { scratchpad: true, conversation: false, longTerm: false },
    handoff: SKILL_HANDOFF,
  };
  assertManifestValid(manifest);
  return { name, manifest, ignored, provenance };
}

let validator: ValidateFunction | undefined;
function manifestValidator(): ValidateFunction {
  if (validator) return validator;
  const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'agent-manifest.schema.json');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const ref = JSON.parse(readFileSync(join(dir, 'prompt-ref.schema.json'), 'utf8')) as Record<string, unknown>;
  ajv.addSchema(ref, './prompt-ref.schema.json');
  validator = ajv.compile(JSON.parse(readFileSync(join(dir, 'agent-manifest.schema.json'), 'utf8')) as Record<string, unknown>);
  return validator;
}

/** Closed-world check against the spec's agent-manifest schema (incl. the RFC 0131 Skill profile). */
export function assertManifestValid(manifest: unknown): void {
  const validate = manifestValidator();
  if (!validate(manifest)) {
    const errors = (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    throw refuse('manifest_invalid', `The converted manifest does not satisfy agent-manifest.schema.json: ${errors.join('; ')}`, { errors });
  }
}
