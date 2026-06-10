/**
 * URL-slug generation. Shared so features (cms, …) don't each re-implement the
 * same normalization (there are already local copies in roster/accessControl;
 * new code uses this one).
 */
export function slugify(input: string, fallback = 'item'): string {
  const base = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
  return base.length > 0 ? base : fallback;
}

/** A slug guaranteed unique within `taken` by appending `-2`, `-3`, … */
export function uniqueSlug(input: string, taken: ReadonlySet<string>, fallback = 'item'): string {
  const base = slugify(input, fallback);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
