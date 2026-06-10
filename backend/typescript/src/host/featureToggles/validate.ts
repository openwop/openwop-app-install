/**
 * Server-side validation for admin-saved toggle configs (ADR §3.2/§3.5).
 *
 * The backend is the authority, so it MUST validate weights sum to 100, variant
 * keys are unique, and bindings are well-formed — the admin UI validates too,
 * but a client check is advisory. Throws OpenwopError(validation_error, 400).
 */

import { OpenwopError } from '../../types.js';
import type {
  BucketUnit,
  FeatureToggleStatus,
  ToggleConfig,
  ToggleOverride,
  Variant,
  VariantBinding,
} from './types.js';

function fail(message: string, field: string): never {
  throw new OpenwopError('validation_error', message, 400, { field });
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`Field \`${field}\` is required and MUST be a non-empty string.`, field);
  }
  return value as string;
}

function status(value: unknown, field: string): FeatureToggleStatus {
  if (value === 'on' || value === 'off' || value === 'beta') return value;
  fail(`Field \`${field}\` MUST be one of "on" | "off" | "beta".`, field);
}

function bucketUnit(value: unknown, field: string): BucketUnit {
  if (value === undefined) return 'user';
  if (value === 'user' || value === 'tenant') return value;
  fail(`Field \`${field}\` MUST be "user" or "tenant".`, field);
}

function binding(value: unknown, field: string): VariantBinding {
  if (!value || typeof value !== 'object') fail(`\`${field}\` MUST be an object.`, field);
  const b = value as { slot?: unknown; ref?: unknown };
  const slot = str(b.slot, `${field}.slot`);
  if (!b.ref || typeof b.ref !== 'object') fail(`\`${field}.ref\` MUST be an object.`, `${field}.ref`);
  const ref = b.ref as { kind?: unknown; name?: unknown; version?: unknown };
  if (ref.kind !== 'agent' && ref.kind !== 'node' && ref.kind !== 'prompt') {
    fail(`\`${field}.ref.kind\` MUST be "agent" | "node" | "prompt".`, `${field}.ref.kind`);
  }
  return {
    slot,
    ref: { kind: ref.kind, name: str(ref.name, `${field}.ref.name`), version: str(ref.version, `${field}.ref.version`) },
  };
}

function variants(value: unknown, field: string): Variant[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`Field \`${field}\` MUST be an array of variants.`, field);
  if (value.length === 0) return [];
  const out: Variant[] = [];
  const keys = new Set<string>();
  let total = 0;
  value.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') fail(`\`${field}[${i}]\` MUST be an object.`, `${field}[${i}]`);
    const v = raw as { key?: unknown; weight?: unknown; bindings?: unknown };
    const key = str(v.key, `${field}[${i}].key`);
    if (keys.has(key)) fail(`Duplicate variant key \`${key}\`.`, `${field}[${i}].key`);
    keys.add(key);
    if (typeof v.weight !== 'number' || !Number.isInteger(v.weight) || v.weight < 0 || v.weight > 100) {
      fail(`\`${field}[${i}].weight\` MUST be an integer in [0, 100].`, `${field}[${i}].weight`);
    }
    total += v.weight;
    let bindings: VariantBinding[] | undefined;
    if (v.bindings !== undefined) {
      if (!Array.isArray(v.bindings)) fail(`\`${field}[${i}].bindings\` MUST be an array.`, `${field}[${i}].bindings`);
      bindings = v.bindings.map((b, j) => binding(b, `${field}[${i}].bindings[${j}]`));
    }
    out.push({ key, weight: v.weight, ...(bindings ? { bindings } : {}) });
  });
  if (total !== 100) {
    fail(`Variant weights MUST sum to exactly 100 (got ${total}).`, field);
  }
  return out;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
    fail(`Field \`${field}\` MUST be an array of strings.`, field);
  }
  return value as string[];
}

function tenantOverrides(value: unknown, field: string): Record<string, ToggleOverride> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`Field \`${field}\` MUST be an object keyed by tenant id.`, field);
  }
  const out: Record<string, ToggleOverride> = {};
  for (const [tenantId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') fail(`\`${field}.${tenantId}\` MUST be an object.`, `${field}.${tenantId}`);
    const o = raw as { status?: unknown; variants?: unknown };
    const ov: ToggleOverride = {};
    if (o.status !== undefined) ov.status = status(o.status, `${field}.${tenantId}.status`);
    const vs = variants(o.variants, `${field}.${tenantId}.variants`);
    if (vs !== undefined) ov.variants = vs;
    out[tenantId] = ov;
  }
  return out;
}

/**
 * Validate + normalize an admin-submitted toggle config. `id` comes from the
 * route path (authoritative); the body supplies the rest.
 */
export function validateToggleConfig(id: string, body: unknown): ToggleConfig {
  if (!body || typeof body !== 'object') fail('Request body MUST be a JSON object.', 'body');
  const b = body as Record<string, unknown>;
  const config: ToggleConfig = {
    id: str(id, 'id'),
    status: status(b.status, 'status'),
    bucketUnit: bucketUnit(b.bucketUnit, 'bucketUnit'),
    salt: typeof b.salt === 'string' && b.salt.length > 0 ? b.salt : id,
  };
  if (typeof b.label === 'string') config.label = b.label;
  if (typeof b.description === 'string') config.description = b.description;
  if (typeof b.category === 'string') config.category = b.category;
  const vs = variants(b.variants, 'variants');
  if (vs !== undefined) config.variants = vs;
  const cohort = stringArray(b.betaCohort, 'betaCohort');
  if (cohort !== undefined) config.betaCohort = cohort;
  const overrides = tenantOverrides(b.tenantOverrides, 'tenantOverrides');
  if (overrides !== undefined) config.tenantOverrides = overrides;
  return config;
}
